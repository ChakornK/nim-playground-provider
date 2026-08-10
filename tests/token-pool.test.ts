import { expect, test } from "bun:test";
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

test("mint failure rejects all waiting acquirers", async () => {
  const src: TokenSource = {
    async mintToken() {
      throw new Error("captcha down");
    },
  };
  const pool = new TokenPool(src, 1);

  await expect(pool.acquire()).rejects.toThrow("captcha down");
});
