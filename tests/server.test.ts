import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { createServer, type ServerDeps } from "../src/server";
import type { TokenPool } from "../src/token-pool";
import type { CatalogEntry, UpstreamChatParams } from "../src/types";
import type { Upstream } from "../src/upstream";

const fixture = () =>
  readFileSync(join(__dirname, "fixtures", "upstream.sse"), "utf8");

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
            model: "z-ai/glm-5.2",
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
  model: "z-ai/glm-5.2",
  port: 0,
  defaultRoute: { modelId: "qc69jvmznzxy/glm-5.2", functionId: "glm-fid" },
};

let server: ReturnType<typeof createServer>;
let base: string;

beforeAll(() => {
  server = createServer(deps);
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
    data: [{ id: "z-ai/glm-5.2", object: "model" }],
  });
});

test("OPTIONS is answered without CORS headers", async () => {
  const r = await fetch(`${base}/v1/models`, { method: "OPTIONS" });
  expect(r.status).toBe(204);
  expect(r.headers.get("access-control-allow-origin")).toBeNull();
});

test("unknown route returns 404 OpenAI error", async () => {
  const r = await fetch(`${base}/nope`, { method: "POST" });
  expect(r.status).toBe(404);
  const body = await r.json();
  expect(body.error.type).toBe("not_found");
});

test("no route available returns 503 without consuming a token", async () => {
  let acquired = 0;
  const noRoute = createServer({
    pool: {
      async acquire() {
        acquired++;
        return "P1_unused";
      },
    } as unknown as TokenPool,
    upstream: upstreamMock(),
    model: "z-ai/glm-5.2",
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

test("POST /v1/chat/completions with non-string content returns 400", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: 5 }] }),
  });
  expect(r.status).toBe(400);
});

test("streaming completion passes translated SSE through and burns one token", async () => {
  const beforeTokens = tokenCalls;
  const beforeChats = chatCalls;
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "z-ai/glm-5.2",
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
  // usage only on the final usage-only frame (choices: []), stripped from delta frames
  expect(data.filter((c) => c.usage)).toHaveLength(1);
  expect(data.filter((c) => c.usage)[0].choices).toEqual([]);

  expect(tokenCalls).toBe(beforeTokens + 1);
  expect(chatCalls).toBe(beforeChats + 1);
  expect(lastParams?.stream).toBe(true);
  expect(lastParams?.token).toBe("P1_fake_token");
  expect(lastParams?.model).toBe("z-ai/glm-5.2");
});

test("non-streaming completion returns an aggregated chat.completion object", async () => {
  const r = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "z-ai/glm-5.2",
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

describe("thinking persistence", () => {
  const seen: UpstreamChatParams[] = [];
  let onChat: (i: number) => Response;
  let tServer: ReturnType<typeof createServer>;
  let tBase: string;

  const chatCompletion = () =>
    new Response(
      JSON.stringify({
        id: "chatcmpl-x",
        object: "chat.completion",
        created: 1,
        model: "z-ai/glm-5.2",
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
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  /** A reasoning stream that is cut off before any content or [DONE]. */
  const abortedStream = () => {
    const enc = new TextEncoder();
    const frame = (reasoning: string) =>
      `data: ${JSON.stringify({
        id: "chatcmpl-x",
        object: "chat.completion.chunk",
        created: 1,
        model: "z-ai/glm-5.2",
        choices: [
          {
            index: 0,
            delta: { reasoning_content: reasoning },
            finish_reason: null,
          },
        ],
      })}\n\n`;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(frame("wait, ")));
          controller.enqueue(enc.encode(frame("hold on")));
          controller.close(); // upstream dropped mid-thinking, no [DONE]
        },
      }),
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );
  };

  beforeAll(() => {
    tServer = createServer({
      pool: {
        async acquire() {
          return "P2_token";
        },
      } as unknown as TokenPool,
      upstream: {
        async chat(params: UpstreamChatParams) {
          seen.push(params);
          return onChat(seen.length - 1);
        },
      } as unknown as Upstream,
      model: "z-ai/glm-5.2",
      defaultRoute: { modelId: "qc69jvmznzxy/glm-5.2", functionId: "glm-fid" },
      port: 0,
    });
    tBase = `http://localhost:${tServer.port}`;
  });
  afterAll(() => tServer.stop(true));
  beforeEach(() => {
    seen.length = 0;
  });

  const post = (
    messages: Array<{ role: string; content: string | null }>,
    opts?: { stream?: boolean },
  ) =>
    fetch(`${tBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, stream: opts?.stream ?? true }),
    });

  test("partial thinking survives a stream aborted before [DONE]", async () => {
    onChat = (i) => (i === 0 ? abortedStream() : chatCompletion());
    await post([{ role: "user", content: "interrupt me" }], { stream: true });
    await post(
      [
        { role: "user", content: "interrupt me" },
        { role: "assistant", content: null }, // client got no answer
        { role: "user", content: "what were you thinking?" },
      ],
      { stream: false },
    );
    expect(seen[1]?.messages[1]).toEqual({
      role: "assistant",
      content: " thinking\nwait, hold on\n response\n",
    });
  });

  test("interrupted thinking is injected even when the client drops the reply", async () => {
    onChat = (i) => (i === 0 ? abortedStream() : chatCompletion());
    await post([{ role: "user", content: "interrupt me" }], { stream: true });
    await post(
      [
        { role: "user", content: "interrupt me" },
        // client got no answer and dropped the interrupted assistant message
        { role: "user", content: "what were you thinking?" },
      ],
      { stream: false },
    );
    expect(seen[1]?.messages[1]).toEqual({
      role: "assistant",
      content: " thinking\nwait, hold on\n response\n",
    });
  });

  test("non-streaming thinking is injected into the follow-up request", async () => {
    onChat = () => chatCompletion();
    await post([{ role: "user", content: "tell me a fact" }], {
      stream: false,
    });
    await post(
      [
        { role: "user", content: "tell me a fact" },
        { role: "assistant", content: "Hello there" },
        { role: "user", content: "why?" },
      ],
      { stream: false },
    );
    expect(seen[1]?.messages[1]).toEqual({
      role: "assistant",
      content: " thinking\nLet me think about it.\n response\nHello there",
    });
  });

  test("thinking from every turn is injected in a multi-turn conversation", async () => {
    onChat = () => chatCompletion();
    await post([{ role: "user", content: "multi" }], { stream: false });
    await post(
      [
        { role: "user", content: "multi" },
        { role: "assistant", content: "Hello there" },
        { role: "user", content: "and?" },
      ],
      { stream: false },
    );
    await post(
      [
        { role: "user", content: "multi" },
        { role: "assistant", content: "Hello there" },
        { role: "user", content: "and?" },
        { role: "assistant", content: "Hello there" },
        { role: "user", content: "more?" },
      ],
      { stream: false },
    );
    const last = seen.at(-1)?.messages;
    expect(last?.[1]?.content).toBe(
      " thinking\nLet me think about it.\n response\nHello there",
    );
    expect(last?.[3]?.content).toBe(
      " thinking\nLet me think about it.\n response\nHello there",
    );
  });

  test("thinking is not injected when the preceding context does not match", async () => {
    onChat = () => chatCompletion();
    await post([{ role: "user", content: "seed" }], { stream: false });
    await post(
      [
        { role: "user", content: "something else" },
        { role: "assistant", content: "Hello there" },
        { role: "user", content: "why?" },
      ],
      { stream: false },
    );
    expect(seen[1]?.messages[1]).toEqual({
      role: "assistant",
      content: "Hello there",
    });
  });
});

describe("with a catalog", () => {
  const catalog = [
    {
      id: "z-ai/glm-5.2",
      slug: "glm-5.2",
      functionId: "glm-fid",
      created: 1700000000,
      ownedBy: "z-ai",
    },
    {
      id: "thinkingmachines/inkling",
      slug: "inkling",
      functionId: "inkling-fid",
      created: 1700000001,
      ownedBy: "thinkingmachines",
    },
  ];
  let catServer: ReturnType<typeof createServer>;
  let catBase: string;

  beforeAll(() => {
    chatCalls = 0;
    lastParams = null;
    catServer = createServer({
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
          id: "z-ai/glm-5.2",
          object: "model",
          created: 1700000000,
          owned_by: "z-ai",
        },
        {
          id: "thinkingmachines/inkling",
          object: "model",
          created: 1700000001,
          owned_by: "thinkingmachines",
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
    expect(body.error.type).toBe("model_not_found");
  });

  test("routing uses the catalog model's slug and function id", async () => {
    const before = chatCalls;
    const r = await fetch(`${catBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "thinkingmachines/inkling",
        messages: [{ role: "user", content: "hi" }],
        stream: true,
      }),
    });
    expect(r.status).toBe(200);
    expect(chatCalls).toBe(before + 1);
    expect(lastParams?.model).toBe("thinkingmachines/inkling");
    expect(lastParams?.route).toEqual({
      modelId: "qc69jvmznzxy/inkling",
      functionId: "inkling-fid",
    });
  });
});

test("server reads the catalog from a mutable provider", async () => {
  let current: CatalogEntry[] = [];
  let chatCallsLocal = 0;
  const catServer = createServer({
    ...deps,
    getCatalog: () => current,
    upstream: {
      async chat(params: UpstreamChatParams) {
        chatCallsLocal++;
        lastParams = params;
        return new Response(
          JSON.stringify({
            id: "chatcmpl-x",
            object: "chat.completion",
            created: 1,
            model: "z-ai/glm-5.2",
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
    model: "z-ai/glm-5.2",
    port: 0,
  });
  const catBase = `http://localhost:${catServer.port}`;
  try {
    // unknown while catalog is empty falls back to the default route
    const r1 = await fetch(`${catBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "thinkingmachines/inkling",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect(r1.status).toBe(200);
    expect(lastParams?.route).toEqual({
      modelId: "qc69jvmznzxy/glm-5.2",
      functionId: "glm-fid",
    });

    // once populated, the same request routes by the catalog entry
    current = [
      {
        id: "thinkingmachines/inkling",
        slug: "inkling",
        functionId: "inkling-fid",
        created: 1,
        ownedBy: "thinkingmachines",
      },
    ];
    const r2 = await fetch(`${catBase}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "thinkingmachines/inkling",
        messages: [{ role: "user", content: "hi" }],
        stream: false,
      }),
    });
    expect(r2.status).toBe(200);
    expect(lastParams?.route).toEqual({
      modelId: "qc69jvmznzxy/inkling",
      functionId: "inkling-fid",
    });
  } finally {
    await catServer.stop(true);
  }
});
