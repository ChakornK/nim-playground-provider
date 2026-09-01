import { expect, test } from "bun:test";
import { BrowserSession, withAbort, withTimeout } from "../src/browser.ts";

test("withTimeout returns the value when the promise resolves in time", async () => {
  const fast = new Promise<string>((r) => setTimeout(() => r("ok"), 5));
  expect(await withTimeout(fast, 1000, "timed out")).toBe("ok");
});

test("withTimeout rejects with msg when the promise hangs", async () => {
  const stuck = new Promise<string>(() => {}); // never settles, no timer refs
  await expect(withTimeout(stuck, 30, "timed out")).rejects.toThrow(
    "timed out",
  );
});

test("withTimeout forwards a non-timeout rejection unchanged", async () => {
  const fail = Promise.reject(new Error("boom"));
  await expect(withTimeout(fail, 1000, "timed out")).rejects.toThrow("boom");
});

test("withAbort releases a stuck operation when reset", async () => {
  const controller = new AbortController();
  const stuck = new Promise<string>(() => {});
  const pending = withAbort(stuck, controller.signal, "mint reset");
  controller.abort();

  await expect(pending).rejects.toMatchObject({
    name: "AbortError",
    message: "mint reset",
  });
});

test("browser reset detaches a stuck startup from the next generation", async () => {
  const session = new BrowserSession({ lightpandaPath: "unused" });
  const internals = session as unknown as {
    startBrowser(gen: number): Promise<void>;
  };
  let starts = 0;
  internals.startBrowser = async () => {
    starts++;
    return new Promise<void>(() => {});
  };

  const first = session.mintToken();
  while (starts < 1) await Bun.sleep(1);
  await session.reset();
  await expect(first).rejects.toMatchObject({ name: "AbortError" });

  const second = session.mintToken();
  const deadline = Date.now() + 100;
  while (starts < 2 && Date.now() < deadline) await Bun.sleep(1);
  expect(starts).toBe(2);

  await session.reset();
  await expect(second).rejects.toMatchObject({ name: "AbortError" });
});
