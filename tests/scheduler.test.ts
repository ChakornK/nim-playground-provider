import { expect, test } from "bun:test";
import { RequestScheduler, SchedulerBackoffError } from "../src/scheduler.ts";

test("scheduler holds excess requests until the active lease releases", async () => {
  const scheduler = new RequestScheduler({ concurrency: 1, minIntervalMs: 0 });
  const first = await scheduler.acquire();
  let secondAcquired = false;
  const secondPromise = scheduler.acquire().then((lease) => {
    secondAcquired = true;
    return lease;
  });

  await Bun.sleep(5);
  expect(secondAcquired).toBe(false);
  first.release();

  const second = await secondPromise;
  expect(secondAcquired).toBe(true);
  second.release();
});

test("scheduler spaces upstream starts", async () => {
  const scheduler = new RequestScheduler({ concurrency: 2, minIntervalMs: 25 });
  const first = await scheduler.acquire();
  const second = await scheduler.acquire();
  const started = Date.now();

  const firstStart = await first.waitForStart();
  firstStart.markStarted();
  const secondStart = await second.waitForStart();
  secondStart.markStarted();

  expect(Date.now() - started).toBeGreaterThanOrEqual(20);
  first.release();
  second.release();
});

test("scheduler backoff fails fast and reopens after cooldown", async () => {
  const scheduler = new RequestScheduler({ concurrency: 1, minIntervalMs: 0 });
  scheduler.backoff(30);

  await expect(scheduler.acquire()).rejects.toBeInstanceOf(
    SchedulerBackoffError,
  );
  await Bun.sleep(35);

  const lease = await scheduler.acquire();
  const start = await lease.waitForStart();
  expect(start.markStarted()).toBe(true);
  lease.release();
});

test("issued permit yields when a newer backoff appears", async () => {
  const scheduler = new RequestScheduler({ concurrency: 1, minIntervalMs: 0 });
  const lease = await scheduler.acquire();
  const issued = await lease.waitForStart();
  scheduler.backoff(30);

  expect(issued.markStarted()).toBe(false);
  await expect(lease.waitForStart()).rejects.toBeInstanceOf(
    SchedulerBackoffError,
  );
  await Bun.sleep(35);
  const retried = await lease.waitForStart();
  expect(retried.markStarted()).toBe(true);
  lease.release();
});

test("aborted paced start releases the next caller", async () => {
  const scheduler = new RequestScheduler({ concurrency: 2, minIntervalMs: 0 });
  const first = await scheduler.acquire();
  const second = await scheduler.acquire();
  const controller = new AbortController();
  controller.abort();

  await expect(first.waitForStart(controller.signal)).rejects.toThrow(
    "aborted",
  );
  const secondStart = await second.waitForStart();
  secondStart.markStarted();
  first.release();
  second.release();
});

test("scheduler backoff rejects requests still queued for a lease", async () => {
  const scheduler = new RequestScheduler({ concurrency: 1, minIntervalMs: 0 });
  const first = await scheduler.acquire();
  const queued = scheduler.acquire();
  scheduler.backoff(30);

  await expect(queued).rejects.toBeInstanceOf(SchedulerBackoffError);
  first.release();
});

test("scheduler removes a queued request when its signal aborts", async () => {
  const scheduler = new RequestScheduler({ concurrency: 1, minIntervalMs: 0 });
  const first = await scheduler.acquire();
  const controller = new AbortController();
  const queued = scheduler.acquire(controller.signal);
  controller.abort();

  await expect(queued).rejects.toThrow("aborted");
  first.release();

  const next = await scheduler.acquire();
  next.release();
});
