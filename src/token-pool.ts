/** Pool of single-use tokens, refills in the background up to capacity.
 * acquire() returns a warm token immediately, else waits for a mint. */
export interface TokenSource {
  mintToken(): Promise<string>;
}

interface Waiter {
  resolve(t: string): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
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
}

const TOKEN_TTL_MS = 120_000;

export class TokenPool {
  private tokens: { value: string; mintedAt: number }[] = [];
  private refilling = false;
  private waiting: Waiter[] = [];
  private warmNotified = false;

  private source: TokenSource;
  private capacity: number;
  private opts: TokenPoolOpts;

  constructor(source: TokenSource, capacity = 2, opts: TokenPoolOpts = {}) {
    this.source = source;
    this.capacity = capacity;
    this.opts = opts;
  }

  /** Start background refilling immediately, non-blocking. */
  prewarm() {
    this.scheduleRefill();
  }

  /** Take a token, blocking until one is available (warm or freshly minted).
   * Warm tokens older than the TTL are discarded; hCaptcha tokens are
   * short-lived. */
  async acquire(): Promise<string> {
    while (this.tokens.length > 0) {
      const t = this.tokens.pop();
      if (t && Date.now() - t.mintedAt < TOKEN_TTL_MS) {
        this.scheduleRefill();
        return t.value;
      }
    }
    const maxWaiters = this.opts.maxWaiters ?? 100;
    if (this.waiting.length >= maxWaiters) {
      throw new Error("too many concurrent requests waiting for a token");
    }
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiting.indexOf(waiter);
        if (idx !== -1) this.waiting.splice(idx, 1);
        reject(new Error("timed out waiting for a token"));
      }, this.opts.acquireTimeoutMs ?? 60_000);
      const waiter: Waiter = { resolve, reject, timer };
      this.waiting.push(waiter);
      this.scheduleRefill();
    });
  }

  private scheduleRefill() {
    if (this.refilling) return;
    this.refilling = true;
    void this.refill().finally(() => {
      this.refilling = false;
      // Waiters added while a refill was failing (e.g. retrying from a
      // rejection handler) need a fresh refill; theirs was skipped above.
      if (this.waiting.length > 0) this.scheduleRefill();
    });
  }

  private async refill() {
    // Keep tokens full and waiters satisfied. Mint one at a time
    // (BrowserSession serializes anyway).
    let deficit = this.capacity - this.tokens.length + this.waiting.length;
    while (deficit > 0) {
      let token: string;
      try {
        token = await this.mintWithRetry();
      } catch (err) {
        // Fail all current waiters; the next acquire() re-triggers a refill.
        const error = err instanceof Error ? err : new Error(String(err));
        this.deliverError(error);
        return;
      }
      const waiter = this.waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(token);
      } else if (this.tokens.length < this.capacity) {
        // A waiter may have timed out while this mint was in flight; only
        // stock the token when the pool still has room.
        this.tokens.push({ value: token, mintedAt: Date.now() });
        if (!this.warmNotified && this.tokens.length >= this.capacity) {
          this.warmNotified = true;
          this.opts.onWarm?.(this.tokens.length, this.capacity);
        }
      }
      deficit = this.capacity - this.tokens.length + this.waiting.length;
    }
  }

  private async mintWithRetry(): Promise<string> {
    const maxRetries = this.opts.maxRetries ?? 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await this.source.mintToken();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private deliverError(err: Error) {
    while (this.waiting.length) {
      const waiter = this.waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.reject(err);
      }
    }
  }
}
