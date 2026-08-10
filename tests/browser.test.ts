import { expect, test } from "bun:test";
import { withTimeout } from "../src/browser";

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
