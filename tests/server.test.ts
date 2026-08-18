import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { parseKeys } from "../src/constants.ts";
import {
  createServer,
  isAuthorized,
  safeEqual,
  type ServerDeps,
  type ServerInstance,
} from "../src/server.ts";
import type { TokenPool } from "../src/token-pool.ts";
import type { CatalogEntry, UpstreamChatParams } from "../src/types.ts";
import type { Upstream } from "../src/upstream.ts";

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
  const noRoute = await createServer({
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

test("upstream non-OK maps to 502 with upstream status", async () => {
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
    expect(r.status).toBe(502);
    const body = await r.json();
    expect(body.error.type).toBe("upstream_error");
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

test("expired captcha token retries with a fresh token", async () => {
  let calls = 0;
  const s = await createServer({
    ...deps,
    upstream: {
      async chat(params: UpstreamChatParams) {
        calls++;
        if (calls === 1) {
          return new Response('{"error":"Invalid captcha token"}', {
            status: 400,
          });
        }
        lastParams = params;
        return new Response(
          JSON.stringify({
            id: "chatcmpl-retry",
            object: "chat.completion",
            created: 1,
            model: "z-ai/glm-5.2",
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
        return "P1_retry_token";
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
    expect(lastParams?.token).toBe("P1_retry_token");
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
    expect(r.status).toBe(502);
    expect(calls).toBe(1);
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
  // usage only on the final usage-only frame (empty choices), stripped from delta frames
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
