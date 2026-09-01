export interface RequestSchedulerOpts {
  /** Maximum number of requests allowed to use NVIDIA concurrently. */
  concurrency?: number;
  /** Minimum delay between starts sent to NVIDIA. */
  minIntervalMs?: number;
  /** Maximum number of requests waiting for a concurrency slot. */
  maxQueue?: number;
}

export interface RequestStartPermit {
  /** Record the start unless a newer backoff requires another reservation. */
  markStarted(): boolean;
  /** Release the next paced caller without recording a start. */
  cancel(): void;
}

export interface RequestLease {
  /** Reserve the next paced start before minting its captcha token. */
  waitForStart(signal?: AbortSignal): Promise<RequestStartPermit>;
  /** Release the concurrency slot. Safe to call more than once. */
  release(): void;
}

interface QueueWaiter {
  signal?: AbortSignal;
  resolve(lease: RequestLease): void;
  reject(error: Error): void;
  onAbort?: () => void;
}

export class SchedulerQueueFullError extends Error {
  constructor() {
    super("too many requests waiting for an upstream slot");
    this.name = "SchedulerQueueFullError";
  }
}

export class SchedulerBackoffError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("NVIDIA requests are cooling down after an upstream failure");
    this.name = "SchedulerBackoffError";
    this.retryAfterMs = Math.max(0, retryAfterMs);
  }
}

const abortError = (): Error => {
  if (typeof DOMException !== "undefined") {
    return new DOMException("request aborted", "AbortError");
  }
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
};

const wait = (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) return Promise.reject(abortError());
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
};

/** Bounds concurrent generations and paces starts to avoid NVIDIA's silent queue throttle. */
export class RequestScheduler {
  private readonly concurrency: number;
  private readonly minIntervalMs: number;
  private readonly maxQueue: number;
  private active = 0;
  private queue: QueueWaiter[] = [];
  private nextStartAt = 0;
  private backoffUntil = 0;
  private startTail: Promise<void> = Promise.resolve();

  constructor(opts: RequestSchedulerOpts = {}) {
    this.concurrency = Math.max(1, Math.trunc(opts.concurrency ?? 1));
    this.minIntervalMs = Math.max(0, opts.minIntervalMs ?? 0);
    this.maxQueue = Math.max(0, Math.trunc(opts.maxQueue ?? 100));
  }

  acquire(signal?: AbortSignal): Promise<RequestLease> {
    if (signal?.aborted) return Promise.reject(abortError());
    const backoff = this.remainingBackoffMs();
    if (backoff > 0) {
      return Promise.reject(new SchedulerBackoffError(backoff));
    }
    if (this.active < this.concurrency && this.queue.length === 0) {
      return Promise.resolve(this.grant(signal));
    }
    if (this.queue.length >= this.maxQueue) {
      return Promise.reject(new SchedulerQueueFullError());
    }
    return new Promise<RequestLease>((resolve, reject) => {
      const waiter: QueueWaiter = { signal, resolve, reject };
      if (signal) {
        waiter.onAbort = () => {
          const index = this.queue.indexOf(waiter);
          if (index !== -1) this.queue.splice(index, 1);
          reject(abortError());
        };
        signal.addEventListener("abort", waiter.onAbort, { once: true });
      }
      this.queue.push(waiter);
    });
  }

  /** Open a cooldown and reject requests that have not acquired a lease. */
  backoff(ms: number): number {
    this.backoffUntil = Math.max(
      this.backoffUntil,
      Date.now() + Math.max(0, ms),
    );
    const remaining = this.remainingBackoffMs();
    if (remaining > 0) {
      for (const waiter of this.queue.splice(0)) {
        if (waiter.onAbort) {
          waiter.signal?.removeEventListener("abort", waiter.onAbort);
        }
        waiter.reject(new SchedulerBackoffError(remaining));
      }
    }
    return remaining;
  }

  remainingBackoffMs(): number {
    return Math.max(0, this.backoffUntil - Date.now());
  }

  private grant(defaultSignal?: AbortSignal): RequestLease {
    this.active++;
    let released = false;
    return {
      waitForStart: (signal = defaultSignal) => this.reserveStart(signal),
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        this.grantQueued();
      },
    };
  }

  private grantQueued(): void {
    while (this.active < this.concurrency) {
      const waiter = this.queue.shift();
      if (!waiter) return;
      if (waiter.signal?.aborted) {
        waiter.reject(abortError());
        continue;
      }
      if (waiter.onAbort) {
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
      }
      waiter.resolve(this.grant(waiter.signal));
    }
  }

  private reserveStart(signal?: AbortSignal): Promise<RequestStartPermit> {
    let releaseGate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });
    const turn = this.startTail
      .catch(() => {})
      .then(async () => {
        try {
          while (true) {
            if (signal?.aborted) throw abortError();
            const backoff = this.remainingBackoffMs();
            if (backoff > 0) throw new SchedulerBackoffError(backoff);
            const delay = this.nextStartAt - Date.now();
            if (delay <= 0) break;
            await wait(delay, signal);
          }
        } catch (error) {
          releaseGate?.();
          throw error;
        }

        let settled = false;
        const settle = (started: boolean) => {
          if (settled) return;
          settled = true;
          if (started) {
            this.nextStartAt = Math.max(
              this.nextStartAt,
              Date.now() + this.minIntervalMs,
            );
          }
          releaseGate?.();
        };
        return {
          markStarted: () => {
            if (this.remainingBackoffMs() > 0) {
              settle(false);
              return false;
            }
            settle(true);
            return true;
          },
          cancel: () => settle(false),
        };
      });
    this.startTail = turn.then(
      () => gate,
      () => undefined,
    );
    return turn;
  }
}
