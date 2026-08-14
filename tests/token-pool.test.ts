import { expect, test } from "vitest";
import { TokenPool, type TokenSource } from "../src/token-pool";

function fakeSource(tokens: string[]): TokenSource & { minted: number } {
  let i = 0;
  return {
    minted: 0,
    async mintToken() {
      this.minted++;
      const t = tokens[i++ % tokens.length];
      await new Promise((r) => setTimeout(r, 1));
      return `${t}-${this.minted}`;
    },
  };
}

test("acquire pops warm tokens and refills in the background", async () => {
  const src = fakeSource(["t1", "t2", "t3"]);
  const pool = new TokenPool(src, 2);

  const a = await pool.acquire();
  const b = await pool.acquire();
  expect(a).toBe("t1-1");
  expect(b).toBe("t2-2");

  // burned 2, capacity 2 -> refill should top back up to 2
  await new Promise((r) => setTimeout(r, 20));
  expect(src.minted).toBeGreaterThanOrEqual(3);

  const c = await pool.acquire();
  expect(c.startsWith("t")).toBe(true);
});

test("acquire waits for a mint when the pool is cold", async () => {
  const src = fakeSource(["t1"]);
  const pool = new TokenPool(src, 1);

  const first = await pool.acquire();
  expect(first).toBe("t1-1");

  const second = pool.acquire(); // pool empty, no warm token -> must mint
  const got = await second;
  expect(got).toBe("t1-2");
});

test("concurrent cold acquires each get a distinct token", async () => {
  const src = fakeSource(["t1", "t2", "t3"]);
  const pool = new TokenPool(src, 2);

  const [a, b, c] = await Promise.all([
    pool.acquire(),
    pool.acquire(),
    pool.acquire(),
  ]);
  const tokens = [a, b, c];
  expect(new Set(tokens).size).toBe(3);
  expect(tokens.every((t) => t.startsWith("t"))).toBe(true);
});

test("mint failure rejects all waiting acquirers", async () => {
  const src: TokenSource = {
    async mintToken() {
      throw new Error("captcha down");
    },
  };
  const pool = new TokenPool(src, 1);

  await expect(pool.acquire()).rejects.toThrow("captcha down");
});

test("acquire times out when the pool stays cold", async () => {
  const src: TokenSource = {
    async mintToken() {
      await new Promise((r) => setTimeout(r, 1000)); // slow, but finite
      throw new Error("unreachable");
    },
  };
  const pool = new TokenPool(src, 1, { acquireTimeoutMs: 30 });

  await expect(pool.acquire()).rejects.toThrow("timed out");
});

test("acquire rejects beyond the waiter cap", async () => {
  const src: TokenSource = {
    async mintToken() {
      await new Promise((r) => setTimeout(r, 1000));
      throw new Error("unreachable");
    },
  };
  const pool = new TokenPool(src, 1, { acquireTimeoutMs: 200, maxWaiters: 1 });

  const first = pool.acquire();
  await expect(pool.acquire()).rejects.toThrow("too many");
  await expect(first).rejects.toThrow("timed out");
});

test("a single mint failure retries before rejecting waiters", async () => {
  let attempts = 0;
  const src: TokenSource = {
    async mintToken() {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "P1_ok";
    },
  };
  const pool = new TokenPool(src, 1, { maxRetries: 2 });

  const token = await pool.acquire();
  expect(token).toBe("P1_ok");
  expect(attempts).toBeGreaterThanOrEqual(3);
});

test("persistent mint failure rejects all waiters after retries exhausted", async () => {
  let attempts = 0;
  const src: TokenSource = {
    async mintToken() {
      attempts++;
      throw new Error("captcha down");
    },
  };
  const pool = new TokenPool(src, 1, { maxRetries: 1 });

  const first = pool.acquire();
  const second = pool.acquire();
  let e1: string | undefined;
  let e2: string | undefined;
  await first.catch((e) => (e1 = (e as Error).message));
  await second.catch((e) => (e2 = (e as Error).message));
  expect(e1).toBe("captcha down");
  expect(e2).toBe("captcha down");
  expect(attempts).toBeGreaterThanOrEqual(2);
});
