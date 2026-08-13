import { describe, expect, test } from "bun:test";
import { ThinkingCache } from "../src/thinking-cache";

const turn = (messages: Array<{ role: string; content: string | null }>) =>
  messages.map((m) => ({ role: m.role, content: m.content ?? null }));

describe("ThinkingCache", () => {
  test("injects cached thinking into a matched assistant turn", () => {
    const cache = new ThinkingCache();
    cache.remember(
      [{ role: "user", content: "hello" }],
      "i need to ...",
      "answer...",
    );
    const out = cache.augment(
      turn([
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi there" },
      ]),
    );
    expect(out[1]?.content).toBe(
      " thinking\ni need to ...\n response\nhi there",
    );
  });

  test("keeps assistant turns it has no thinking for", () => {
    const cache = new ThinkingCache();
    const messages = turn([{ role: "assistant", content: "lonely" }]);
    expect(cache.augment(messages)).toEqual(messages);
  });

  test("fills in the cached answer when the stored assistant reply is empty", () => {
    const cache = new ThinkingCache();
    cache.remember([{ role: "user", content: "q" }], "r", "a");
    const out = cache.augment(
      turn([
        { role: "user", content: "q" },
        { role: "assistant", content: null },
      ]),
    );
    expect(out[1]?.content).toBe(" thinking\nr\n response\na");
  });

  test("ignores turns with empty reasoning", () => {
    const cache = new ThinkingCache();
    cache.remember([{ role: "user", content: "q" }], "  ", "a");
    const messages = turn([
      { role: "user", content: "q" },
      { role: "assistant", content: "x" },
    ]);
    expect(cache.augment(messages)).toEqual(messages);
  });
});
