import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseKeys } from "../src/constants.ts";
import type {
  EgressCoordinator,
  GenerationLease,
  GenerationOutcome,
} from "../src/egress.ts";
import {
  createServer,
  isAuthorized,
  type ServerDeps,
  type ServerInstance,
  safeEqual,
} from "../src/server.ts";
import type { TokenPool } from "../src/token-pool.ts";
import type { CatalogEntry, UpstreamChatParams } from "../src/types.ts";
import { Upstream, UpstreamHeadersTimeoutError } from "../src/upstream.ts";

const fixture = () =>
  readFileSync(join(import.meta.dir, "fixtures", "upstream.sse"), "utf8");

let tokenCalls = 0;
let chatCalls = 0;
let lastParams: UpstreamChatParams | null = null;

const upstreamMock = () =>
  ({
    async chat(params: UpstreamChatParams) {
      chatCalls++;
      lastParams = params;
      if (!params.stream) {
        return new Response(
          JSON.stringify({
            id: "chatcmpl-upstream-fake",
            object: "chat.completion",
            created: 1754200000,
            model: "publisher1/model1",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Hello there",
                  reasoning_content: "Let me think about it.",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 9, completion_tokens: 5, total_tokens: 14 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(fixture(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    },
  }) as unknown as Upstream;

const deps: ServerDeps = {
  pool: {
    async acquire() {
      tokenCalls++;
      return "P1_fake_token";
    },
  } as unknown as TokenPool,
  upstream: upstreamMock(),
  model: "publisher1/model1",
  port: 0,
  defaultRoute: {
    modelId: "test-namespace/default-model",
    functionId: "default-fid",
  },
  upstreamConcurrency: 1,
  upstreamMinIntervalMs: 0,
  upstreamBackoffMs: 0,
};

let server: ServerInstance;
let base: string;

beforeAll(async () => {
  server = await createServer(deps);
  base = `http://localhost:${server.port}`;
});
afterAll(() => server.stop(true));

test("server binds loopback by default", () => {
  expect(server.hostname).toBe("127.0.0.1");
});

test("GET /v1/models advertises the model", async () => {
  const r = await fetch(`${base}/v1/models`);
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body).toEqual({
    object: "list",
    data: [
      {
        id: "publisher1/model1",
        object: "model",
        created: 0,
        owned_by: "publisher1",
      },
    ],
  });
});

test("OPTIONS is answered without CORS headers", async () => {
  const r = await fetch(`${base}/v1/models`, { method: "OPTIONS" });
  expect(r.status).toBe(204);
  expect(r.headers.get("access-control-allow-origin")).toBeNull();
});

test("oversized request body returns 413", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "x".repeat(4 * 1024 * 1024 + 1) }],
    }),
  });
  expect(r.status).toBe(413);
});

test("oversized chunked body without content-length returns 413", async () => {
  const chunk = new TextEncoder().encode("x".repeat(1024 * 1024));
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < 5; i++) controller.enqueue(chunk);
      controller.close();
    },
  });
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // @ts-expect-error undici requires duplex for streamed bodies
    duplex: "half",
    body,
  });
  expect(r.status).toBe(413);
});

test("unknown route returns 404 OpenAI error", async () => {
  const r = await fetch(`${base}/nope`, { method: "POST" });
  expect(r.status).toBe(404);
  const body = await r.json();
  expect(body.error.type).toBe("not_found");
});

test("no route available returns 503 without consuming a token", async () => {
  let acquired = 0;
  const noRoute = await createServer({
    pool: {
      async acquire() {
        acquired++;
        return "P1_unused";
      },
    } as unknown as TokenPool,
    upstream: upstreamMock(),
    model: "publisher1/model1",
    port: 0,
  });
  try {
    const r = await fetch(
      `http://localhost:${noRoute.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      },
    );
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.error.type).toBe("server_error");
    expect(acquired).toBe(0);
  } finally {
    await noRoute.stop(true);
  }
});

test("fallback route constraints filter explicit Kimi sampling params", async () => {
  let upstreamBody: Record<string, unknown> | undefined;
  const upstream = new Upstream({
    fetchImpl: (async (_url, init) => {
      upstreamBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return upstreamMock().chat({
        token: "P1_unused",
        messages: [],
        model: "moonshotai/kimi-k3",
        route: { modelId: "namespace/kimi-k3", functionId: "function-id" },
        enableThinking: false,
        stream: false,
      });
    }) as typeof fetch,
  });
  const s = await createServer({
    ...deps,
    catalog: [],
    model: "moonshotai/kimi-k3",
    defaultRoute: {
      modelId: "namespace/kimi-k3",
      functionId: "function-id",
      params: ["messages", "model", "stream", "max_tokens"],
    },
    upstream,
  });
  try {
    const r = await fetch(`http://localhost:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "hi" }],
        top_p: 1,
      }),
    });
    expect(r.status).toBe(200);
    expect(upstreamBody).not.toHaveProperty("top_p");
  } finally {
    await s.stop(true);
  }
});

test("upstream throw maps to 502 upstream_error", async () => {
  const s = await createServer({
    ...deps,
    upstream: {
      async chat() {
        throw new Error("boom");
      },
    } as unknown as Upstream,
  });
  const base2 = `http://localhost:${s.port}`;
  try {
    const r = await fetch(`${base2}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body.error.type).toBe("upstream_error");
  } finally {
    await s.stop(true);
  }
});

test("upstream headers timeout returns 504 without retry amplification", async () => {
  let calls = 0;
  const s = await createServer({
    ...deps,
    upstreamBackoffMs: 2_000,
    upstream: {
      async chat() {
        calls++;
        throw new UpstreamHeadersTimeoutError(120_000);
      },
    } as unknown as Upstream,
  });
  const base2 = `http://localhost:${s.port}`;
  try {
    const r = await fetch(`${base2}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(504);
    expect(r.headers.get("retry-after")).toBe("2");
    const body = await r.json();
    expect(body.error.code).toBe("upstream_timeout");

    const cooldown = await fetch(`${base2}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(cooldown.status).toBe(429);
    expect((await cooldown.json()).error.code).toBe("upstream_cooldown");
    expect(calls).toBe(1);
  } finally {
    await s.stop(true);
  }
});

test("stalled non-stream body times out, cancels, and releases its lease", async () => {
  let calls = 0;
  let cancelled = false;
  const s = await createServer({
    ...deps,
    upstreamBodyTimeoutMs: 15,
    upstream: {
      async chat(params: UpstreamChatParams) {
        calls++;
        if (calls === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
              },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        return upstreamMock().chat(params);
      },
    } as unknown as Upstream,
  });
  const post = () =>
    fetch(`http://localhost:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
  try {
    const stalled = await post();
    expect(stalled.status).toBe(504);
    expect((await stalled.json()).error.code).toBe("upstream_body_timeout");
    expect(cancelled).toBe(true);
    expect((await post()).status).toBe(200);
    expect(calls).toBe(2);
  } finally {
    await s.stop(true);
  }
});

test("stalled upstream error body cannot pin the scheduler lease", async () => {
  let calls = 0;
  let cancelled = false;
  const s = await createServer({
    ...deps,
    upstreamBodyTimeoutMs: 15,
    upstream: {
      async chat(params: UpstreamChatParams) {
        calls++;
        if (calls === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
                return new Promise<void>(() => {});
              },
            }),
            { status: 503 },
          );
        }
        return upstreamMock().chat(params);
      },
    } as unknown as Upstream,
  });
  const post = () =>
    fetch(`http://localhost:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
  try {
    const stalled = await post();
    expect(stalled.status).toBe(504);
    expect(cancelled).toBe(true);
    expect((await post()).status).toBe(200);
    expect(calls).toBe(2);
  } finally {
    await s.stop(true);
  }
});

test("scheduler holds a second request until the first completion ends", async () => {
  let calls = 0;
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const s = await createServer({
    ...deps,
    upstreamConcurrency: 1,
    upstream: {
      async chat(params: UpstreamChatParams) {
        calls++;
        if (calls === 1) await firstGate;
        return upstreamMock().chat(params);
      },
    } as unknown as Upstream,
  });
  const post = () =>
    fetch(`http://localhost:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
  try {
    const first = post();
    const second = post();
    while (calls === 0) await Bun.sleep(1);
    await Bun.sleep(10);
    expect(calls).toBe(1);
    releaseFirst?.();
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(calls).toBe(2);
  } finally {
    releaseFirst?.();
    await s.stop(true);
  }
});

test("pacing is measured at actual upstream starts after token minting", async () => {
  let tokenCalls = 0;
  const starts: number[] = [];
  const s = await createServer({
    ...deps,
    upstreamConcurrency: 2,
    upstreamMinIntervalMs: 40,
    pool: {
      async acquire() {
        const call = ++tokenCalls;
        if (call === 1) await Bun.sleep(45);
        return `P1_token_${call}`;
      },
    } as unknown as TokenPool,
    upstream: {
      async chat(params: UpstreamChatParams) {
        starts.push(Date.now());
        return upstreamMock().chat(params);
      },
    } as unknown as Upstream,
  });
  const post = () =>
    fetch(`http://localhost:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
  try {
    const responses = await Promise.all([post(), post()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(starts).toHaveLength(2);
    expect(
      Math.abs((starts[1] ?? 0) - (starts[0] ?? 0)),
    ).toBeGreaterThanOrEqual(35);
  } finally {
    await s.stop(true);
  }
});

test("upstream 429 passes through with its status", async () => {
  const s = await createServer({
    ...deps,
    upstream: {
      async chat() {
        return new Response("rate limited", { status: 429 });
      },
    } as unknown as Upstream,
  });
  const base2 = `http://localhost:${s.port}`;
  try {
    const r = await fetch(`${base2}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(429);
    const body = await r.json();
    expect(body.error.message).toContain("429");
  } finally {
    await s.stop(true);
  }
});

test("mint failure maps to 503 server_error", async () => {
  const s = await createServer({
    ...deps,
    pool: {
      async acquire() {
        throw new Error("captcha down");
      },
    } as unknown as TokenPool,
  });
  const base2 = `http://localhost:${s.port}`;
  try {
    const r = await fetch(`${base2}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(503);
    const body = await r.json();
    expect(body.error.type).toBe("server_error");
    expect(body.error.message).toContain("captcha");
  } finally {
    await s.stop(true);
  }
});

test("Kimi token rejection resets the captcha session before retrying", async () => {
  let calls = 0;
  let tokens = 0;
  let invalidations = 0;
  const s = await createServer({
    ...deps,
    model: "moonshotai/kimi-k3",
    upstream: {
      async chat(params: UpstreamChatParams) {
        calls++;
        if (calls === 1) {
          return new Response(
            '{"requestStatus":{"statusCode":"INVALID_REQUEST","statusDescription":"Token is invalid"}}',
            { status: 400 },
          );
        }
        lastParams = params;
        return new Response(
          JSON.stringify({
            id: "chatcmpl-retry",
            object: "chat.completion",
            created: 1,
            model: "moonshotai/kimi-k3",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "ok" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Upstream,
    pool: {
      async acquire() {
        tokens++;
        return `P1_retry_token_${tokens}`;
      },
      async invalidate() {
        invalidations++;
      },
    } as unknown as TokenPool,
  });
  const base2 = `http://localhost:${s.port}`;
  try {
    const r = await fetch(`${base2}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        stream: false,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    expect(r.status).toBe(200);
    expect(calls).toBe(2);
    expect(tokens).toBe(2);
    expect(invalidations).toBe(1);
    expect(lastParams?.token).toBe("P1_retry_token_2");
  } finally {
    await s.stop(true);
  }
});

test("invalid token count is a client error, not a captcha rejection", async () => {
  let calls = 0;
  let invalidations = 0;
  const s = await createServer({
    ...deps,
    upstream: {
      async chat() {
        calls++;
        return new Response("invalid token count for this request", {
          status: 400,
        });
      },
    } as unknown as Upstream,
    pool: {
      async acquire() {
        return "P1_valid";
      },
      async invalidate() {
        invalidations++;
      },
    } as unknown as TokenPool,
  });
  try {
    const r = await fetch(`http://localhost:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(400);
    expect(calls).toBe(1);
    expect(invalidations).toBe(0);
  } finally {
    await s.stop(true);
  }
});

test("400 mentioning tokens but not captcha is not retried", async () => {
  let calls = 0;
  const s = await createServer({
    ...deps,
    upstream: {
      async chat() {
        calls++;
        return new Response("max_tokens exceeds the context window", {
          status: 400,
        });
      },
    } as unknown as Upstream,
  });
  const base2 = `http://localhost:${s.port}`;
  try {
    const r = await fetch(`${base2}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(400);
    expect((await r.json()).error.type).toBe("invalid_request_error");
    expect(calls).toBe(1);
  } finally {
    await s.stop(true);
  }
});

test("non-captcha upstream errors are not retried", async () => {
  let calls = 0;
  const s = await createServer({
    ...deps,
    upstream: {
      async chat() {
        calls++;
        return new Response("rate limited", { status: 429 });
      },
    } as unknown as Upstream,
  });
  const base2 = `http://localhost:${s.port}`;
  try {
    const r = await fetch(`${base2}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
    expect(r.status).toBe(429);
    expect(calls).toBe(1);
  } finally {
    await s.stop(true);
  }
});

test("400 capacity validation does not globally back off requests", async () => {
  let calls = 0;
  const s = await createServer({
    ...deps,
    upstreamBackoffMs: 500,
    upstream: {
      async chat(params: UpstreamChatParams) {
        calls++;
        if (calls === 1) {
          return new Response("requested token count exceeds model capacity", {
            status: 400,
          });
        }
        return upstreamMock().chat(params);
      },
    } as unknown as Upstream,
  });
  const post = () =>
    fetch(`http://localhost:${s.port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    });
  try {
    expect((await post()).status).toBe(400);
    const second = post();
    const quick = await Promise.race([second, Bun.sleep(250).then(() => null)]);
    expect(quick?.status).toBe(200);
    if (!quick) await second;
  } finally {
    await s.stop(true);
  }
});

test("POST /v1/chat/completions with empty messages returns 400", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [] }),
  });
  expect(r.status).toBe(400);
  const body = await r.json();
  expect(body.error.type).toBe("invalid_request_error");
});

test("POST /v1/chat/completions normalizes null content to empty string", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      stream: false,
      messages: [{ role: "user", content: null }],
    }),
  });
  expect(r.status).toBe(200);
  expect(lastParams?.messages[0]?.content).toBe("");
});

test("stream omitted defaults to a non-streaming JSON completion", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("application/json");
  const body = await r.json();
  expect(body.object).toBe("chat.completion");
});

test("streaming completion passes translated SSE through and burns one token", async () => {
  const beforeTokens = tokenCalls;
  const beforeChats = chatCalls;
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "publisher1/model1",
      messages: [{ role: "user", content: "say hi" }],
      stream: true,
    }),
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("text/event-stream");
  expect(r.headers.get("x-accel-buffering")).toBe("no");

  const text = await r.text();
  expect(text.trim().endsWith("data: [DONE]")).toBe(true);

  const frames = text.trim().split(/\n\n+/).filter(Boolean);
  const data = frames
    .filter((f) => f.startsWith("data: ") && !f.includes("[DONE]"))
    .map((f) => JSON.parse(f.replace(/^data: /, "")));
  // usage only on the final usage-only frame (empty choices), stripped from delta frames
  expect(data.filter((c) => c.usage)).toHaveLength(1);
  expect(data.filter((c) => c.usage)[0].choices).toEqual([]);

  expect(tokenCalls).toBe(beforeTokens + 1);
  expect(chatCalls).toBe(beforeChats + 1);
  expect(lastParams?.stream).toBe(true);
  expect(lastParams?.token).toBe("P1_fake_token");
  expect(lastParams?.model).toBe("publisher1/model1");
});

test("non-streaming completion returns an aggregated chat.completion object", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "publisher1/model1",
      messages: [{ role: "user", content: "say hi" }],
      stream: false,
    }),
  });
  expect(r.status).toBe(200);
  expect(r.headers.get("content-type")).toBe("application/json");
  const completion = await r.json();
  expect(completion.object).toBe("chat.completion");
  expect(completion.choices[0].message.content).toBe("Hello there");
  expect(completion.choices[0].message.reasoning_content).toBe(
    "Let me think about it.",
  );
  expect(completion.choices[0].finish_reason).toBe("stop");
  expect(completion.usage).toEqual({
    prompt_tokens: 9,
    completion_tokens: 5,
    total_tokens: 14,
  });
  expect(completion.id).toMatch(/^chatcmpl-/);
});

test("enable_thinking=false is forwarded to upstream params", async () => {
  await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "x" }],
      enable_thinking: false,
      stream: false,
    }),
  });
  expect(lastParams?.enableThinking).toBe(false);
});

test("tools are forwarded to upstream", async () => {
  const tools = [
    { type: "function", function: { name: "Bash", parameters: {} } },
  ];
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: "list files" }],
      tools,
      stream: true,
    }),
  });
  expect(r.status).toBe(200);
  expect(lastParams?.tools).toEqual(tools);
});

test("tool result messages (null content, tool_call_id) are accepted", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_1",
              type: "function",
              function: { name: "Bash", arguments: "{}" },
            },
          ],
        },
        { role: "tool", content: "output", tool_call_id: "call_1" },
        { role: "user", content: "done" },
      ],
      stream: true,
    }),
  });
  expect(r.status).toBe(200);
  expect(lastParams?.messages).toHaveLength(3);
});

describe("with a catalog", () => {
  const catalog = [
    {
      id: "publisher1/model2",
      slug: "model2",
      namespace: "test-namespace",
      functionId: "model2-fid",
      created: 1700000000,
      ownedBy: "publisher1",
    },
    {
      id: "publisher2/model1",
      slug: "model1",
      namespace: "test-namespace",
      functionId: "model1-fid",
      created: 1700000001,
      ownedBy: "publisher2",
    },
  ];
  let catServer: ServerInstance;
  let catBase: string;

  beforeAll(async () => {
    chatCalls = 0;
    lastParams = null;
    catServer = await createServer({
      ...deps,
      upstream: upstreamMock(),
      catalog,
    });
    catBase = `http://localhost:${catServer.port}`;
  });
  afterAll(() => catServer.stop(true));

  test("GET /v1/models lists the catalog", async () => {
    const r = await fetch(`${catBase}/v1/models`);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body).toEqual({
      object: "list",
      data: [
        {
          id: "publisher1/model2",
          object: "model",
          created: 1700000000,
          owned_by: "publisher1",
        },
        {
          id: "publisher2/model1",
          object: "model",
          created: 1700000001,
          owned_by: "publisher2",
        },
      ],
    });
  });

  test("unknown model returns 404 model_not_found", async () => {
    const r = await fetch(`${catBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "nope/does-not-exist",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect(r.status).toBe(404);
    const body = await r.json();
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("model_not_found");
  });

  test("routing uses the catalog model's slug and function id", async () => {
    const before = chatCalls;
    const r = await fetch(`${catBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "publisher2/model1",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(r.status).toBe(200);
    expect(chatCalls).toBe(before + 1);
    expect(lastParams?.model).toBe("publisher2/model1");
    expect(lastParams?.route).toEqual({
      modelId: "test-namespace/model1",
      functionId: "model1-fid",
    });
  });
});

test("server reads the catalog from a mutable provider", async () => {
  let current: CatalogEntry[] = [];
  const catServer = await createServer({
    ...deps,
    getCatalog: () => current,
    upstream: {
      async chat(params: UpstreamChatParams) {
        lastParams = params;
        return new Response(
          JSON.stringify({
            id: "chatcmpl-x",
            object: "chat.completion",
            created: 1,
            model: "publisher1/model1",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "hi",
                  reasoning_content: "",
                },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    } as unknown as Upstream,
    model: "publisher1/model1",
    port: 0,
  });
  const catBase = `http://localhost:${catServer.port}`;
  try {
    // empty catalog: the default model uses the default route
    const r1 = await fetch(`${catBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "publisher1/model1",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect(r1.status).toBe(200);
    expect(lastParams?.route).toEqual({
      modelId: "test-namespace/default-model",
      functionId: "default-fid",
    });

    // empty catalog: unknown models are rejected, not silently rerouted
    const r1b = await fetch(`${catBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "publisher2/model1",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect(r1b.status).toBe(404);

    // once populated, the same request routes by the catalog entry
    current = [
      {
        id: "publisher2/model1",
        slug: "model1",
        namespace: "test-namespace",
        functionId: "model1-fid",
        created: 1,
        ownedBy: "publisher2",
      },
    ];
    const r2 = await fetch(`${catBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "publisher2/model1",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect(r2.status).toBe(200);
    expect(lastParams?.route).toEqual({
      modelId: "test-namespace/model1",
      functionId: "model1-fid",
    });
  } finally {
    await catServer.stop(true);
  }
});

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randStr(rng: () => number, max = 12): string {
  const n = Math.floor(rng() * max) + 1;
  let s = "";
  for (let i = 0; i < n; i++) {
    if (rng() < 0.3) s += String.fromCharCode(0xa0 + Math.floor(rng() * 0x500));
    else s += String.fromCharCode(32 + Math.floor(rng() * 95));
  }
  return s;
}

function randAscii(rng: () => number, max = 10): string {
  const n = Math.floor(rng() * max) + 1;
  let s = "";
  for (let i = 0; i < n; i++)
    s += String.fromCharCode(32 + Math.floor(rng() * 95));
  return s;
}

describe("safeEqual", () => {
  test("agrees with strict equality and never throws", () => {
    const rng = mulberry32(1234);
    for (let i = 0; i < 80; i++) {
      const a = randStr(rng);
      const b = rng() < 0.5 ? a : randStr(rng);
      let threw = false;
      let got: boolean | undefined;
      try {
        got = safeEqual(a, b);
      } catch {
        threw = true;
      }
      expect(threw).toBe(false);
      expect(got).toBe(a === b);
    }
  });
});

const AUTH_SCHEMES = ["Bearer", "bearer", "BEARER", "BeArEr"];

describe("isAuthorized", () => {
  test("membership with case-insensitive scheme; empty set disables auth", () => {
    const rng = mulberry32(99);
    for (let i = 0; i < 80; i++) {
      const nkeys = Math.floor(rng() * 3) + 1;
      const keys = Array.from({ length: nkeys }, () => randAscii(rng, 10));
      const inSet = rng() < 0.5;
      const token = inSet
        ? (keys[Math.floor(rng() * nkeys)] ?? randAscii(rng, 10))
        : randAscii(rng, 10);
      const scheme = AUTH_SCHEMES[Math.floor(rng() * AUTH_SCHEMES.length)];
      const pad = rng() < 0.5 ? " " : "  ";
      const req = new Request("http://x/v1/models", {
        headers: { authorization: `${scheme}${pad}${token}${pad}` },
      });
      expect(isAuthorized(req, keys)).toBe(keys.includes(token));
      expect(isAuthorized(req, [])).toBe(true);
    }
  });

  test("missing header and non-bearer schemes are rejected", () => {
    const rng = mulberry32(7);
    const keys = ["k1"];
    for (let i = 0; i < 24; i++) {
      const bad = ["Basic", "Token", "bearer-x", ""][Math.floor(rng() * 4)];
      const req =
        bad === ""
          ? new Request("http://x")
          : new Request("http://x", {
              headers: { authorization: `${bad} ${randAscii(rng, 6)}` },
            });
      expect(isAuthorized(req, keys)).toBe(false);
    }
  });
});

describe("parseKeys", () => {
  test("equals split-trim-filter", () => {
    const rng = mulberry32(42);
    const ref = (s: string) =>
      s
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean);
    expect(parseKeys("")).toEqual([]);
    expect(parseKeys(",")).toEqual([]);
    expect(parseKeys(", ,")).toEqual([]);
    expect(parseKeys(" a , b ,c")).toEqual(["a", "b", "c"]);
    expect(parseKeys("secret1, secret2 ,secret3")).toEqual([
      "secret1",
      "secret2",
      "secret3",
    ]);
    for (let i = 0; i < 80; i++) {
      const nk = Math.floor(rng() * 4) + 1;
      const parts = Array.from({ length: nk }, () => {
        const seg = rng() < 0.25 ? "" : randStr(rng, 8);
        return (rng() < 0.3 ? " " : "") + seg + (rng() < 0.3 ? " " : "");
      });
      const raw = parts.join(",");
      expect(parseKeys(raw)).toEqual(ref(raw));
    }
  });
});

describe("bearer key auth", () => {
  test("401 identical body for missing header, wrong scheme, and wrong key", async () => {
    const s = await createServer({ ...deps, apiKeys: ["k"] });
    const base = `http://localhost:${s.port}`;
    try {
      const cases: Array<[string, Record<string, string> | undefined]> = [
        ["no header", undefined],
        ["Basic", { authorization: "Basic k" }],
        ["wrong key", { authorization: "Bearer wrong" }],
      ];
      const bodies: string[] = [];
      for (const [, hdrs] of cases) {
        const r = await fetch(`${base}/v1/models`, { headers: hdrs });
        expect(r.status).toBe(401);
        const body = await r.json();
        expect(body.error.code).toBe("invalid_api_key");
        bodies.push(JSON.stringify(body));
      }
      expect(new Set(bodies).size).toBe(1);
    } finally {
      await s.stop(true);
    }
  });

  test("authorized request reaches /v1/models and /v1/chat/completions", async () => {
    const s = await createServer({ ...deps, apiKeys: ["k"] });
    const base = `http://localhost:${s.port}`;
    try {
      const m = await fetch(`${base}/v1/models`, {
        headers: { authorization: "Bearer k" },
      });
      expect(m.status).toBe(200);
      const c = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer k",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hi" }],
          stream: false,
        }),
      });
      expect(c.status).toBe(200);
      const completion = await c.json();
      expect(completion.object).toBe("chat.completion");
    } finally {
      await s.stop(true);
    }
  });

  test("OPTIONS passes without a key while auth enabled", async () => {
    const s = await createServer({ ...deps, apiKeys: ["k"] });
    const base = `http://localhost:${s.port}`;
    try {
      const r = await fetch(`${base}/v1/models`, { method: "OPTIONS" });
      expect(r.status).toBe(204);
    } finally {
      await s.stop(true);
    }
  });

  test("unauthorized request does not consume a token", async () => {
    let acquired = 0;
    const s = await createServer({
      ...deps,
      apiKeys: ["k"],
      pool: {
        async acquire() {
          acquired++;
          return "P1_unused";
        },
      } as unknown as TokenPool,
    });
    const base = `http://localhost:${s.port}`;
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong",
        },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      });
      expect(r.status).toBe(401);
      expect(acquired).toBe(0);
    } finally {
      await s.stop(true);
    }
  });

  test("disabled auth keeps no-header responses unchanged", async () => {
    const s = await createServer({ ...deps, apiKeys: [] });
    const base = `http://localhost:${s.port}`;
    try {
      const m = await fetch(`${base}/v1/models`);
      expect(m.status).toBe(200);
      const n = await fetch(`${base}/nope`, { method: "POST" });
      expect(n.status).toBe(404);
      const body = await n.json();
      expect(body.error.type).toBe("not_found");
    } finally {
      await s.stop(true);
    }
  });

  test("the last configured key is accepted", async () => {
    const s = await createServer({ ...deps, apiKeys: ["a", "b", "c"] });
    const base = `http://localhost:${s.port}`;
    try {
      const r = await fetch(`${base}/v1/models`, {
        headers: { authorization: "Bearer c" },
      });
      expect(r.status).toBe(200);
    } finally {
      await s.stop(true);
    }
  });
});

describe("upstream abort handling", () => {
  const abortDeps = () => {
    let calls = 0;
    let tokens = 0;
    return {
      calls: () => calls,
      tokens: () => tokens,
      deps: {
        ...deps,
        pool: {
          async acquire() {
            tokens++;
            return `P1_token_${tokens}`;
          },
        } as unknown as TokenPool,
        upstream: {
          async chat() {
            calls++;
            throw new DOMException("This operation was aborted", "AbortError");
          },
        } as unknown as Upstream,
      } satisfies ServerDeps,
    };
  };

  const post = (base: string) =>
    fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "publisher1/model1",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

  test("an upstream abort is not amplified into duplicate requests", async () => {
    const h = abortDeps();
    const s = await createServer(h.deps);
    try {
      const r = await post(`http://localhost:${s.port}`);
      expect(r.status).toBe(502);
      const body = await r.json();
      expect(body.error.type).toBe("upstream_error");
      expect(body.error.message).toContain("aborted");
      expect(h.calls()).toBe(1);
      expect(h.tokens()).toBe(1);
    } finally {
      await s.stop(true);
    }
  });

  test("a connection reset is not retried", async () => {
    const h = abortDeps();
    const failing = {
      async chat() {
        throw new Error("connection reset");
      },
    } as unknown as Upstream;
    const s = await createServer({ ...h.deps, upstream: failing });
    try {
      const r = await post(`http://localhost:${s.port}`);
      expect(r.status).toBe(502);
      expect(h.tokens()).toBe(1);
    } finally {
      await s.stop(true);
    }
  });
});

describe("stream without finish_reason preserves unrelated warm tokens", () => {
  const truncatedSSE =
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n';
  const healthySSE =
    truncatedSSE +
    'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n' +
    "data: [DONE]\n\n";

  const streamingDeps = (sse: string, onInvalidate: () => void) => {
    const upstream = {
      async chat() {
        return new Response(sse, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        });
      },
    } as unknown as Upstream;
    const pool = {
      async acquire() {
        return "P1_stream_token";
      },
      invalidate: onInvalidate,
    } as unknown as TokenPool;
    return { ...deps, upstream, pool };
  };

  const postStream = async (server: ServerInstance) => {
    const r = await fetch(
      `http://localhost:${server.port}/v1/chat/completions`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "publisher1/model1",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      },
    );
    return { status: r.status, body: await r.text() };
  };

  test("truncated stream reports an error without burning warm tokens", async () => {
    let invalidations = 0;
    const s = await createServer(
      streamingDeps(truncatedSSE, () => invalidations++),
    );
    try {
      const { status, body } = await postStream(s);
      expect(status).toBe(200);
      expect(body).toContain('"code":"stream_incomplete"');
      expect(body).not.toContain("data: [DONE]");
      expect(invalidations).toBe(0);
    } finally {
      await s.stop(true);
    }
  });

  test("idle stream emits an error and releases its scheduler lease", async () => {
    let calls = 0;
    let cancelled = false;
    const upstream = {
      async chat() {
        calls++;
        if (calls === 1) {
          return new Response(
            new ReadableStream<Uint8Array>({
              cancel() {
                cancelled = true;
                return new Promise<void>(() => {});
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        }
        return new Response(healthySSE, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    } as unknown as Upstream;
    const pool = {
      async acquire() {
        return "P1_stream_token";
      },
      async invalidate() {},
    } as unknown as TokenPool;
    const s = await createServer({
      ...deps,
      upstream,
      pool,
      upstreamStreamIdleTimeoutMs: 15,
    });
    try {
      const stalled = await postStream(s);
      expect(stalled.status).toBe(200);
      expect(stalled.body).toContain('"code":"stream_incomplete"');
      expect(cancelled).toBe(true);
      const healthy = await postStream(s);
      expect(healthy.body).toContain("data: [DONE]");
      expect(calls).toBe(2);
    } finally {
      await s.stop(true);
    }
  });

  test("healthy stream with finish_reason leaves the pool alone", async () => {
    let invalidations = 0;
    const s = await createServer(
      streamingDeps(healthySSE, () => invalidations++),
    );
    try {
      const { status, body } = await postStream(s);
      expect(status).toBe(200);
      expect(body).toContain("data: [DONE]");
      expect(invalidations).toBe(0);
    } finally {
      await s.stop(true);
    }
  });
});

describe("route-aware egress integration", () => {
  interface LeaseStep {
    routeId: string;
    tokenError?: Error;
    chat(params: UpstreamChatParams, call: number): Promise<Response>;
  }

  const scriptedEgress = (steps: LeaseStep[]) => {
    const outcomes: Array<{ routeId: string; outcome: GenerationOutcome }> = [];
    const chats: Array<{ routeId: string; token: string }> = [];
    let acquisitions = 0;
    let tokenCalls = 0;
    let invalidations = 0;
    let accepting = true;
    const egress: EgressCoordinator = {
      proxyMode: true,
      async acquire() {
        if (!accepting) throw new Error("closed");
        const step = steps[acquisitions++];
        if (!step) throw new Error("no scripted lease");
        let finished = false;
        const lease: GenerationLease = {
          epochId: acquisitions,
          routeId: step.routeId,
          routeKind: "proxy",
          signal: new AbortController().signal,
          async acquireToken() {
            tokenCalls++;
            if (step.tokenError) throw step.tokenError;
            return `P1_${step.routeId}_${tokenCalls}`;
          },
          async chat(params) {
            chats.push({ routeId: step.routeId, token: params.token });
            return step.chat(params, chats.length);
          },
          async invalidateCaptcha() {
            invalidations++;
          },
          async finish(outcome) {
            if (finished) return;
            finished = true;
            outcomes.push({ routeId: step.routeId, outcome });
          },
        };
        return lease;
      },
      beginShutdown() {
        accepting = false;
      },
      async drain() {
        return true;
      },
      async close() {
        accepting = false;
      },
    };
    return {
      egress,
      outcomes,
      chats,
      acquisitions: () => acquisitions,
      tokenCalls: () => tokenCalls,
      invalidations: () => invalidations,
    };
  };

  const postWithEgress = (server: ServerInstance) =>
    fetch(`${server.url}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "publisher1/model1",
        messages: [{ role: "user", content: "hi" }],
      }),
    });

  test("token and NVIDIA chat use one generation lease", async () => {
    const scripted = scriptedEgress([
      {
        routeId: "route-a",
        chat: async (params) => upstreamMock().chat(params),
      },
    ]);
    const s = await createServer({ ...deps, egress: scripted.egress });
    try {
      expect((await postWithEgress(s)).status).toBe(200);
      expect(scripted.chats).toEqual([
        { routeId: "route-a", token: "P1_route-a_1" },
      ]);
      expect(scripted.outcomes).toEqual([
        { routeId: "route-a", outcome: "success" },
      ]);
    } finally {
      await s.stop(true);
    }
  });

  test("token failure safely rotates before one NVIDIA dispatch", async () => {
    const scripted = scriptedEgress([
      {
        routeId: "route-a",
        tokenError: new Error("proxy unavailable"),
        chat: async (params) => upstreamMock().chat(params),
      },
      {
        routeId: "route-b",
        chat: async (params) => upstreamMock().chat(params),
      },
    ]);
    const s = await createServer({ ...deps, egress: scripted.egress });
    try {
      expect((await postWithEgress(s)).status).toBe(200);
      expect(scripted.acquisitions()).toBe(2);
      expect(scripted.chats).toHaveLength(1);
      expect(scripted.chats[0]?.routeId).toBe("route-b");
      expect(scripted.outcomes).toEqual([
        { routeId: "route-a", outcome: "pre_dispatch_route_failure" },
        { routeId: "route-b", outcome: "success" },
      ]);
    } finally {
      await s.stop(true);
    }
  });

  test("post-dispatch timeout is not replayed on another route", async () => {
    const scripted = scriptedEgress([
      {
        routeId: "route-a",
        async chat() {
          throw new UpstreamHeadersTimeoutError(120_000);
        },
      },
      {
        routeId: "route-b",
        chat: async (params) => upstreamMock().chat(params),
      },
    ]);
    const s = await createServer({
      ...deps,
      egress: scripted.egress,
      upstreamBackoffMs: 10,
      upstreamMaxBackoffMs: 10,
    });
    try {
      expect((await postWithEgress(s)).status).toBe(504);
      expect(scripted.acquisitions()).toBe(1);
      expect(scripted.chats).toHaveLength(1);
      expect(scripted.outcomes).toEqual([
        { routeId: "route-a", outcome: "ambiguous_post_dispatch_failure" },
      ]);
    } finally {
      await s.stop(true);
    }
  });

  test("provider-global failure does not report a route failure", async () => {
    const scripted = scriptedEgress([
      {
        routeId: "route-a",
        async chat() {
          return new Response("service unavailable", { status: 503 });
        },
      },
    ]);
    const s = await createServer({
      ...deps,
      egress: scripted.egress,
      upstreamBackoffMs: 10,
      upstreamMaxBackoffMs: 10,
    });
    try {
      expect((await postWithEgress(s)).status).toBe(502);
      expect(scripted.outcomes).toEqual([
        { routeId: "route-a", outcome: "provider_global_failure" },
      ]);
    } finally {
      await s.stop(true);
    }
  });

  test("definitive captcha rejection retries on the same lease once", async () => {
    const scripted = scriptedEgress([
      {
        routeId: "route-a",
        async chat(params, call) {
          if (call === 1) {
            return new Response(
              '{"requestStatus":{"statusDescription":"Token is invalid"}}',
              { status: 400 },
            );
          }
          return upstreamMock().chat(params);
        },
      },
    ]);
    const s = await createServer({ ...deps, egress: scripted.egress });
    try {
      expect((await postWithEgress(s)).status).toBe(200);
      expect(scripted.acquisitions()).toBe(1);
      expect(scripted.tokenCalls()).toBe(2);
      expect(scripted.invalidations()).toBe(1);
      expect(scripted.chats).toHaveLength(2);
      expect(scripted.outcomes).toEqual([
        { routeId: "route-a", outcome: "success" },
      ]);
    } finally {
      await s.stop(true);
    }
  });

  test("shutdown admission gate rejects new completions", async () => {
    const scripted = scriptedEgress([]);
    const s = await createServer({ ...deps, egress: scripted.egress });
    try {
      s.beginShutdown();
      const response = await postWithEgress(s);
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe("server_shutting_down");
      expect(scripted.acquisitions()).toBe(0);
    } finally {
      await s.stop(true);
    }
  });

  test("generation abort terminates a stalled response stream", async () => {
    const controller = new AbortController();
    let outcome: GenerationOutcome | undefined;
    let cancelled = false;
    const egress: EgressCoordinator = {
      proxyMode: true,
      async acquire() {
        return {
          epochId: 1,
          routeId: "route-a",
          routeKind: "proxy",
          signal: controller.signal,
          async acquireToken() {
            return "P1_route_a";
          },
          async chat() {
            return new Response(
              new ReadableStream<Uint8Array>({
                start(streamController) {
                  streamController.enqueue(
                    new TextEncoder().encode(
                      'data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n',
                    ),
                  );
                },
                cancel() {
                  cancelled = true;
                },
              }),
              { headers: { "content-type": "text/event-stream" } },
            );
          },
          async invalidateCaptcha() {},
          async finish(value) {
            outcome = value;
          },
        };
      },
      beginShutdown() {},
      async drain() {
        controller.abort();
        return false;
      },
      async close() {},
    };
    const s = await createServer({
      ...deps,
      egress,
      upstreamStreamIdleTimeoutMs: 1_000,
    });
    try {
      const response = await fetch(`${s.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "publisher1/model1",
          messages: [{ role: "user", content: "hi" }],
          stream: true,
        }),
      });
      expect(response.status).toBe(200);
      await egress.drain(0);
      await expect(response.text()).resolves.toBeString();
      expect(cancelled).toBe(true);
      expect(outcome).toBe("ambiguous_post_dispatch_failure");
    } finally {
      await s.stop(true);
    }
  });
});
