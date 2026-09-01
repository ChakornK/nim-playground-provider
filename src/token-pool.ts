/** Pool of single-use tokens, refills in the background up to capacity.
 * acquire() returns a warm token immediately, else waits for a mint. */
export interface TokenSource {
  mintToken(): Promise<string>;
  /** Reset source state and cancel any mint still in progress. */
  reset?(): Promise<void>;
}

interface Waiter {
  resolve(t: string): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onAbort?: () => void;
}

export interface TokenPoolOpts {
  /** How long a cold `acquire()` waits for a mint before rejecting. */
  acquireTimeoutMs?: number;
  /** Hard limit on concurrent waiters, acquirers beyond it are rejected. */
  maxWaiters?: number;
  /** Extra mint attempts after the first failure within one refill.
   * Sources usually retry themselves; the default adds none. */
  maxRetries?: number;
  /** Fires once when the warm pool first reaches `capacity`. */
  onWarm?: (warm: number, capacity: number) => void;
  /** Reports mint and source-reset failures. */
  onError?: (error: Error) => void;
  /** Initial delay before retrying a failed background prewarm. */
  prewarmRetryMs?: number;
  /** Maximum background prewarm delay after repeated failures. */
  maxPrewarmRetryMs?: number;
}

const TOKEN_TTL_MS = 120_000;

const abortError = (): Error => {
  if (typeof DOMException !== "undefined") {
    return new DOMException("request aborted", "AbortError");
  }
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
};

export class TokenPool {
  private tokens: { value: string; mintedAt: number }[] = [];
  private refilling = false;
  private waiting: Waiter[] = [];
  private warmNotified = false;
  private keepWarm = false;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryFailures = 0;
  private generation = 0;
  private resetting: Promise<void> | null = null;
  private closed = false;

  private source: TokenSource;
  private capacity: number;
  private opts: TokenPoolOpts;

  constructor(source: TokenSource, capacity = 1, opts: TokenPoolOpts = {}) {
    this.source = source;
    this.capacity = Math.max(1, Math.trunc(capacity));
    this.opts = opts;
  }

  /** Start background refilling immediately, non-blocking. */
  prewarm(): void {
    if (this.closed) return;
    this.keepWarm = true;
    this.scheduleRefill();
  }

  /** Discard warm and in-flight tokens, then reset the minting source. */
  async invalidate(): Promise<void> {
    if (this.closed) return;
    this.tokens = [];
    this.generation++;
    if (this.source.reset && !this.resetting) {
      const reset = Promise.resolve().then(() => this.source.reset?.());
      this.resetting = reset;
      try {
        await reset;
      } catch (error) {
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        this.opts.onError?.(normalized);
        throw normalized;
      } finally {
        if (this.resetting === reset) this.resetting = null;
        this.scheduleRefill();
      }
      return;
    }
    if (this.resetting) await this.resetting;
    this.scheduleRefill();
  }

  /** Stop retries and reject requests that are still waiting for a token. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.generation++;
    this.tokens = [];
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.deliverError(new Error("token pool is closed"));
  }

  /** Take a token, blocking until one is available (warm or freshly minted).
   * Warm tokens older than the TTL are discarded. */
  async acquire(signal?: AbortSignal): Promise<string> {
    if (this.closed) throw new Error("token pool is closed");
    if (signal?.aborted) throw abortError();
    while (this.tokens.length > 0) {
      const token = this.tokens.pop();
      if (token && Date.now() - token.mintedAt < TOKEN_TTL_MS) {
        this.scheduleRefill();
        return token.value;
      }
    }
    const maxWaiters = this.opts.maxWaiters ?? 100;
    if (this.waiting.length >= maxWaiters) {
      throw new Error("too many concurrent requests waiting for a token");
    }
    return new Promise<string>((resolve, reject) => {
      let waiter: Waiter;
      const remove = () => {
        const index = this.waiting.indexOf(waiter);
        if (index !== -1) this.waiting.splice(index, 1);
        signal?.removeEventListener("abort", onAbort);
      };
      const timer = setTimeout(() => {
        remove();
        reject(new Error("timed out waiting for a token"));
      }, this.opts.acquireTimeoutMs ?? 60_000);
      const onAbort = () => {
        clearTimeout(timer);
        remove();
        reject(abortError());
      };
      waiter = { resolve, reject, timer, signal, onAbort };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.waiting.push(waiter);
      this.scheduleRefill();
    });
  }

  private scheduleRefill(): void {
    if (this.closed || this.refilling) return;
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.refilling = true;
    void this.refill().finally(() => {
      this.refilling = false;
      if (!this.closed && this.waiting.length > 0) this.scheduleRefill();
    });
  }

  private async refill(): Promise<void> {
    while (!this.closed) {
      const deficit = this.capacity - this.tokens.length + this.waiting.length;
      if (deficit <= 0) return;
      if (this.resetting) await this.resetting;
      if (this.closed) return;

      const generation = this.generation;
      let token: string;
      try {
        token = await this.mintWithRetry();
      } catch (error) {
        if (this.closed) return;
        if (generation !== this.generation) continue;
        const normalized =
          error instanceof Error ? error : new Error(String(error));
        this.retryFailures++;
        this.opts.onError?.(normalized);
        this.deliverError(normalized);
        if (this.keepWarm) this.schedulePrewarmRetry();
        return;
      }
      if (this.closed) return;
      if (generation !== this.generation) continue;

      this.retryFailures = 0;
      const waiter = this.waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        if (waiter.onAbort) {
          waiter.signal?.removeEventListener("abort", waiter.onAbort);
        }
        waiter.resolve(token);
      } else if (this.tokens.length < this.capacity) {
        this.tokens.push({ value: token, mintedAt: Date.now() });
        if (!this.warmNotified && this.tokens.length >= this.capacity) {
          this.warmNotified = true;
          this.opts.onWarm?.(this.tokens.length, this.capacity);
        }
      }
    }
  }

  private schedulePrewarmRetry(): void {
    if (this.closed || this.retryTimer) return;
    const initial = Math.max(1, this.opts.prewarmRetryMs ?? 5_000);
    const maximum = Math.max(initial, this.opts.maxPrewarmRetryMs ?? 120_000);
    const exponent = Math.min(8, Math.max(0, this.retryFailures - 1));
    const delay = Math.min(maximum, initial * 2 ** exponent);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.scheduleRefill();
    }, delay);
    this.retryTimer.unref();
  }

  private async mintWithRetry(): Promise<string> {
    const maxRetries = this.opts.maxRetries ?? 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (this.closed) throw new Error("token pool is closed");
      try {
        return await this.source.mintToken();
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  private deliverError(error: Error): void {
    while (this.waiting.length > 0) {
      const waiter = this.waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        if (waiter.onAbort) {
          waiter.signal?.removeEventListener("abort", waiter.onAbort);
        }
        waiter.reject(error);
      }
    }
  }
}
