import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSSE } from "../src/sse.ts";
import { transformStream } from "../src/translate.ts";
import { buildUpstreamBody } from "../src/upstream.ts";

const fixture = () =>
  readFileSync(join(import.meta.dir, "fixtures", "upstream.sse"), "utf8");

/** Turn a string into a ReadableStream, chunked unevenly to exercise the parser. */
function streamOf(text: string, chunk = 40): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const bytes = enc.encode(text);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < bytes.length; i += chunk) {
        controller.enqueue(bytes.subarray(i, i + chunk));
      }
      controller.close();
    },
  });
}

const collect = async <T>(it: AsyncGenerator<T>) => {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
};

test("body builder matches captured upstream shape (stream=true)", () => {
  const body = buildUpstreamBody({
    model: "publisher1/model1",
    messages: [{ role: "user", content: "hi" }],
    enableThinking: true,
    stream: true,
  });
  expect(body).toEqual({
    stream: true,
    chat_template_kwargs: { enable_thinking: true, clear_thinking: false },
    model: "publisher1/model1",
    temperature: 1,
    top_p: 1,
    max_tokens: 16384,
    messages: [{ role: "user", content: "hi" }],
    stream_options: { include_usage: true, continuous_usage_stats: true },
  });
});

test("body builder omits stream_options when stream=false", () => {
  const body = buildUpstreamBody({
    model: "publisher1/model1",
    messages: [{ role: "user", content: "hi" }],
    enableThinking: false,
    stream: false,
  });
  expect(body).toEqual({
    stream: false,
    chat_template_kwargs: { enable_thinking: false, clear_thinking: false },
    model: "publisher1/model1",
    temperature: 1,
    top_p: 1,
    max_tokens: 16384,
    messages: [{ role: "user", content: "hi" }],
  });
  expect(body).not.toHaveProperty("stream_options");
  expect(body).not.toHaveProperty("tools");
});

test("body builder forwards tools when provided", () => {
  const tools = [
    { type: "function", function: { name: "Bash", parameters: {} } },
  ];
  const body = buildUpstreamBody({
    model: "publisher1/model1",
    messages: [{ role: "user", content: "list files" }],
    enableThinking: true,
    stream: true,
    tools,
  });
  expect(body).toHaveProperty("tools", tools);
  const bodyNoTools = buildUpstreamBody({
    model: "publisher1/model1",
    messages: [{ role: "user", content: "hi" }],
    enableThinking: true,
    stream: true,
    tools: [],
  });
  expect(bodyNoTools).not.toHaveProperty("tools");
});

test("body builder drops params the model doesn't support", () => {
  const base = {
    model: "publisher1/model1",
    messages: [{ role: "user", content: "hi" }],
    enableThinking: true,
    stream: false,
  };
  const body = buildUpstreamBody({
    ...base,
    temperature: 0.5,
    topP: 0.9,
    maxTokens: 100,
    allowedParams: ["messages", "temperature", "stream"],
  });
  expect(body).not.toHaveProperty("top_p");
  expect(body).not.toHaveProperty("max_tokens");
  expect(body).toHaveProperty("temperature", 0.5);

  // defaults are not injected either when unsupported
  const noDefaults = buildUpstreamBody({
    ...base,
    allowedParams: ["messages", "stream"],
  });
  expect(noDefaults).not.toHaveProperty("temperature");
  expect(noDefaults).not.toHaveProperty("top_p");
  expect(noDefaults).not.toHaveProperty("max_tokens");
});

test("parseSSE yields each data line, ignores blank lines and CRLF", async () => {
  const raw = "data: a\r\ndata: b\n\n\n\ndata: c";
  const lines = await collect(parseSSE(streamOf(raw)));
  expect(lines).toEqual(["a", "b", "c"]);
});

test("transformStream emits a coded error frame when the stream ends without finish_reason", async () => {
  const raw =
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}}\n\n';
  const frames = await collect(transformStream(streamOf(raw)));
  expect(frames).toHaveLength(2);
  const first = frames[0] as string;
  const parsed = JSON.parse(first.replace(/^data: /, "")) as {
    usage?: { total_tokens: number };
  };
  expect(parsed.usage?.total_tokens).toBe(2);
  const errorFrame = JSON.parse(
    (frames[1] as string).replace(/^data: /, ""),
  ) as { error: { type: string; code: string; message: string } };
  expect(errorFrame.error.type).toBe("upstream_error");
  expect(errorFrame.error.code).toBe("stream_incomplete");
});

test("transformStream drops malformed frames", async () => {
  const raw =
    "data: not json\n\n" +
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
    "data: [DONE]\n\n";
  const frames = await collect(transformStream(streamOf(raw)));
  expect(frames).toHaveLength(2);
  expect(frames[0]).toContain('"content":"hi"');
  expect(frames[1]).toBe("data: [DONE]\n\n");
});

test("transformStream keeps reasoning/content deltas and strips usage except final frame", async () => {
  const frames = await collect(transformStream(streamOf(fixture())));
  expect(frames.at(-1)).toBe("data: [DONE]\n\n");
  // all non-terminator frames are data lines
  const data = frames.slice(0, -1);
  expect(data).toHaveLength(6); // 6 upstream chunks, one of them a usage-only frame
  const parsed = data.map((f) => JSON.parse(f.replace(/^data: /, "")));

  const usageFrames = parsed.filter((c) => c.usage);
  const contentFrames = parsed.filter((c) => c.choices?.[0]?.delta?.content);
  const reasoningFrames = parsed.filter(
    (c) => c.choices?.[0]?.delta?.reasoning_content,
  );

  expect(
    reasoningFrames.map((c) => c.choices[0]?.delta.reasoning_content),
  ).toEqual(["Let me think", " about it."]);
  expect(contentFrames.map((c) => c.choices[0]?.delta.content)).toEqual([
    "Hello",
    " there",
  ]);
  // usage kept only on the final frame (the usage-only frame before [DONE])
  expect(usageFrames).toHaveLength(1);
  expect(usageFrames[0].choices).toEqual([]);
});
