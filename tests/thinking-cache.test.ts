import { describe, expect, test } from "bun:test";
import { ThinkingCache } from "../src/thinking-cache";
import type { OpenAIMessage } from "../src/types";

describe("ThinkingCache", () => {
  test("injects cached thinking into a matched assistant turn", () => {
    const cache = new ThinkingCache();
    cache.remember(
      [{ role: "user", content: "hello" }],
      "i need to ...",
      "answer...",
    );
    const messages: OpenAIMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi there" },
    ];
    expect(cache.augment(messages)[1]?.content).toBe(
      " thinking\ni need to ...\n response\nhi there",
    );
  });

  test("does not inject when the preceding context differs", () => {
    const cache = new ThinkingCache();
    cache.remember([{ role: "user", content: "seed" }], "...", "a");
    const messages: OpenAIMessage[] = [
      { role: "user", content: "elsewhere" },
      { role: "assistant", content: "reply" },
    ];
    expect(cache.augment(messages)[1]?.content).toBe("reply");
  });

  test("injects thinking into later turns of a multi-turn conversation", () => {
    const cache = new ThinkingCache();
    cache.remember([{ role: "user", content: "u1" }], "r1", "a1");
    cache.remember(
      [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
      "r2",
      "a2",
    );
    const messages: OpenAIMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
      { role: "user", content: "u3" },
    ];
    const out = cache.augment(messages);
    expect(out[1]?.content).toBe(" thinking\nr1\n response\na1");
    expect(out[3]?.content).toBe(" thinking\nr2\n response\na2");
  });

  test("keeps assistant turns it has no thinking for", () => {
    const cache = new ThinkingCache();
    const messages: OpenAIMessage[] = [
      { role: "assistant", content: "lonely" },
    ];
    expect(cache.augment(messages)).toEqual(messages);
  });

  test("fills in a cached answer when the stored assistant reply is empty", () => {
    const cache = new ThinkingCache();
    cache.remember([{ role: "user", content: "q" }], "r", "a");
    const messages: OpenAIMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: null },
    ];
    expect(cache.augment(messages)[1]?.content).toBe(
      " thinking\nr\n response\na",
    );
  });

  test("ignores turns with empty reasoning", () => {
    const cache = new ThinkingCache();
    cache.remember([{ role: "user", content: "q" }], "  ", "a");
    const messages: OpenAIMessage[] = [
      { role: "user", content: "q" },
      { role: "assistant", content: "x" },
    ];
    expect(cache.augment(messages)).toEqual(messages);
  });

  test("inserts a synthetic assistant turn when the interrupted reply was dropped", () => {
    const cache = new ThinkingCache();
    cache.remember(
      [{ role: "user", content: "interrupt me" }],
      "wait, hold on",
      "",
    );
    const messages: OpenAIMessage[] = [
      { role: "user", content: "interrupt me" },
      { role: "user", content: "what were you thinking?" },
    ];
    expect(cache.augment(messages)).toEqual([
      { role: "user", content: "interrupt me" },
      {
        role: "assistant",
        content: " thinking\nwait, hold on\n response\n",
      },
      { role: "user", content: "what were you thinking?" },
    ]);
  });

  test("inserts dropped-turn thinking mid-conversation and augments other turns", () => {
    const cache = new ThinkingCache();
    cache.remember([{ role: "user", content: "u1" }], "r1", "a1");
    cache.remember(
      [
        { role: "user", content: "u1" },
        { role: "assistant", content: "a1" },
        { role: "user", content: "u2" },
      ],
      "r2",
      "a2",
    );
    const messages: OpenAIMessage[] = [
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "user", content: "u3" },
    ];
    expect(cache.augment(messages)).toEqual([
      { role: "user", content: "u1" },
      {
        role: "assistant",
        content: " thinking\nr1\n response\na1",
      },
      { role: "user", content: "u2" },
      {
        role: "assistant",
        content: " thinking\nr2\n response\na2",
      },
      { role: "user", content: "u3" },
    ]);
  });

  test("does not insert a synthetic turn when the drop has no cached thinking", () => {
    const cache = new ThinkingCache();
    const messages: OpenAIMessage[] = [
      { role: "user", content: "u1" },
      { role: "user", content: "u2" },
    ];
    expect(cache.augment(messages)).toEqual(messages);
  });
});
