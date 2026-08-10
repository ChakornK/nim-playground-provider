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
}

export class TokenPool {
  private tokens: string[] = [];
  private refilling = false;
  private waiting: Waiter[] = [];

  constructor(
    private source: TokenSource,
    private capacity = 2,
  ) {}

  /** Take a token, blocking until one is available (warm or freshly minted). */
  async acquire(): Promise<string> {
    const token = this.tokens.pop();
    if (token) {
      this.scheduleRefill();
      return token;
    }
    this.scheduleRefill();
    return new Promise<string>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
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
        token = await this.source.mintToken();
      } catch (err) {
        // Fail all current waiters with this error; keep the pool quiet.
        const error = err instanceof Error ? err : new Error(String(err));
        this.deliverError(error);
        return;
      }
      const waiter = this.waiting.shift();
      if (waiter) waiter.resolve(token);
      else this.tokens.push(token);
      deficit = this.capacity - this.tokens.length + this.waiting.length;
    }
  }

  private deliverError(err: Error) {
    while (this.waiting.length) {
      this.waiting.shift()?.reject(err);
    }
  }
}
