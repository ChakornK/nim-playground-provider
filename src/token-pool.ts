/**
 * Pool of single-use tokens. Refills in the background up to `capacity`.
 * `acquire()` returns a token immediately if one is warm, else waits for a mint.
 */
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
  /** Hard limit on concurrent waiters; new acquirers beyond it are rejected. */
  maxWaiters?: number;
  /** Extra mint attempts after the first failure within one refill. */
  maxRetries?: number;
  /** Fires once when the warm pool first reaches `capacity`. */
  onWarm?: (warm: number, capacity: number) => void;
}

export class TokenPool {
  private tokens: string[] = [];
  private refilling = false;
  private waiting: Waiter[] = [];
  private rearming = false;
  private warmNotified = false;

  private source: TokenSource;
  private capacity: number;
  private opts: TokenPoolOpts;

  constructor(source: TokenSource, capacity = 2, opts: TokenPoolOpts = {}) {
    this.source = source;
    this.capacity = capacity;
    this.opts = opts;
  }

  /** Start background refilling immediately, without blocking. */
  prewarm() {
    this.scheduleRefill();
  }

  /** Take a token, blocking until one is available (warm or freshly minted). */
  async acquire(): Promise<string> {
    const token = this.tokens.pop();
    if (token) {
      this.scheduleRefill();
      return token;
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
    });
  }

  private async refill() {
    // Target: keep `tokens` full and all waiters satisfied. Mint one at a time
    // (BrowserSession serializes mints anyway).
    let deficit = this.capacity - this.tokens.length + this.waiting.length;
    while (deficit > 0) {
      let token: string;
      try {
        token = await this.mintWithRetry();
      } catch (err) {
        // Fail all current waiters with this error; re-arm so the pool heals
        // without waiting for the next acquire.
        const error = err instanceof Error ? err : new Error(String(err));
        this.deliverError(error);
        this.rearm();
        return;
      }
      const waiter = this.waiting.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(token);
      } else {
        this.tokens.push(token);
        if (!this.warmNotified && this.tokens.length >= this.capacity) {
          this.warmNotified = true;
          this.opts.onWarm?.(this.tokens.length, this.capacity);
        }
      }
      deficit = this.capacity - this.tokens.length + this.waiting.length;
    }
  }

  private async mintWithRetry(): Promise<string> {
    const maxRetries = this.opts.maxRetries ?? 2;
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

  private rearm() {
    if (this.rearming) return;
    this.rearming = true;
    setTimeout(() => {
      this.rearming = false;
      this.scheduleRefill();
    }, 1_000);
  }
}
