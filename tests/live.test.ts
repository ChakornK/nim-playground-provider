import { expect, test } from "bun:test";
import { BrowserSession } from "../src/browser.ts";
import { resolveModelRoute } from "../src/catalog.ts";
import { detectLightpanda, env } from "../src/constants.ts";
import {
  createRuntimeEpochFactory,
  RotatingEgressCoordinator,
} from "../src/egress.ts";
import { loadProxyFile } from "../src/proxy-list.ts";
import { createServer } from "../src/server.ts";
import { TokenPool, type TokenSource } from "../src/token-pool.ts";
import { Upstream } from "../src/upstream.ts";

const LIVE = !!process.env.NVIDIA_LIVE;
const PROXY_LIVE = LIVE && !!process.env.NVIDIA_PROXY_LIVE;

/** Real deploy route for the default model, resolved against the queue endpoint. */
const route = () => resolveModelRoute(env.model);

test.skipIf(!LIVE)(
  "live: streaming completion shows reasoning then content and terminates with [DONE]",
  async () => {
    const session = new BrowserSession({ lightpandaPath: detectLightpanda() });
    const pool = new TokenPool(session, 1);
    const upstream = new Upstream();
    const server = await createServer({
      pool,
      upstream,
      model: env.model,
      defaultRoute: (await route()) ?? undefined,
      port: 0,
    });
    const base = `http://localhost:${server.port}`;
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "say hello in 3 words" }],
          stream: true,
        }),
      });
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toBe("text/event-stream");
      const text = await r.text();
      expect(text).toContain("reasoning_content");
      expect(text).toContain("content");
      expect(text.trim().endsWith("data: [DONE]")).toBe(true);
    } finally {
      pool.close();
      await server.stop(true);
      await session.close();
    }
  },
  180000,
);

test.skipIf(!LIVE)(
  "live: tool call comes back as structured delta.tool_calls (not <tool_call> XML text)",
  async () => {
    const session = new BrowserSession({ lightpandaPath: detectLightpanda() });
    const pool = new TokenPool(session, 1);
    const upstream = new Upstream();
    const server = await createServer({
      pool,
      upstream,
      model: env.model,
      defaultRoute: (await route()) ?? undefined,
      port: 0,
    });
    const base = `http://localhost:${server.port}`;
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [
            {
              role: "user",
              content:
                "list the files in /home/chakorn/Projects/github/nim-playground-provider",
            },
          ],
          tools: [
            {
              type: "function",
              function: {
                name: "Bash",
                description: "Run a shell command",
                parameters: {
                  type: "object",
                  properties: { command: { type: "string" } },
                  required: ["command"],
                },
              },
            },
          ],
          stream: true,
        }),
      });
      expect(r.status).toBe(200);
      const text = await r.text();
      // structured tool_calls present
      expect(text).toContain('"tool_calls"');
      // the model's native XML must not leak into content
      expect(text).not.toContain("<tool_call>");
      const done = text.trim().endsWith("data: [DONE]");
      expect(done).toBe(true);
    } finally {
      pool.close();
      await server.stop(true);
      await session.close();
    }
  },
  180000,
);

test.skipIf(!LIVE)(
  "live: non-streaming completion returns an aggregated chat.completion",
  async () => {
    const session = new BrowserSession({ lightpandaPath: detectLightpanda() });
    const pool = new TokenPool(session, 1);
    const upstream = new Upstream();
    const server = await createServer({
      pool,
      upstream,
      model: env.model,
      defaultRoute: (await route()) ?? undefined,
      port: 0,
    });
    const base = `http://localhost:${server.port}`;
    try {
      const r = await fetch(`${base}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "say hello in 3 words" }],
          stream: false,
        }),
      });
      expect(r.status).toBe(200);
      const completion = await r.json();
      expect(completion.object).toBe("chat.completion");
      expect(typeof completion.choices[0].message.content).toBe("string");
      expect(completion.choices[0].message.content.length).toBeGreaterThan(0);
      expect(completion.usage.total_tokens).toBeGreaterThan(0);
    } finally {
      pool.close();
      await server.stop(true);
      await session.close();
    }
  },
  180000,
);

test.skipIf(!PROXY_LIVE)(
  "live: user-supplied proxy preserves Kimi completion affinity",
  async () => {
    const proxyFile = await loadProxyFile(env.proxyFile);
    expect(proxyFile.state).toBe("loaded");
    const firstRoute = proxyFile.routes[0];
    if (!firstRoute) throw new Error("proxy file has no valid route");
    const egress = new RotatingEgressCoordinator({
      routes: [firstRoute],
      factory: createRuntimeEpochFactory({
        lightpandaPath: detectLightpanda(),
        poolSize: 1,
        headersTimeoutMs: env.upstreamHeadersTimeoutMs,
      }),
      baseBackoffMs: 1_000,
      maxBackoffMs: 1_000,
    });
    const server = await createServer({
      egress,
      model: env.model,
      defaultRoute: (await route()) ?? undefined,
      upstreamMinIntervalMs: 0,
      port: 0,
    });
    try {
      const response = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "reply exactly: OK" }],
          stream: false,
          enable_thinking: false,
          max_tokens: 128,
          top_p: 1,
        }),
      });
      expect(response.status).toBe(200);
      expect(JSON.stringify(await response.json())).toContain("OK");
      expect(
        egress
          .getHealthSnapshot()
          .find((item) => item.routeId === firstRoute.id),
      ).toMatchObject({ consecutiveFailures: 0, active: true });
    } finally {
      server.beginShutdown();
      await egress.drain(2_000);
      await server.stop(true);
      await egress.close();
    }
  },
  240000,
);

test.skipIf(!LIVE)(
  "live: invalid Kimi captcha token resets the browser and retries once",
  async () => {
    const session = new BrowserSession({ lightpandaPath: detectLightpanda() });
    let mints = 0;
    let resets = 0;
    const source: TokenSource = {
      async mintToken() {
        mints++;
        if (mints === 1) return "P1_invalid";
        return session.mintToken();
      },
      async reset() {
        resets++;
        await session.reset();
      },
    };
    const pool = new TokenPool(source, 1);
    pool.prewarm();
    const server = await createServer({
      pool,
      upstream: new Upstream(),
      model: env.model,
      defaultRoute: (await route()) ?? undefined,
      upstreamMinIntervalMs: 0,
      port: 0,
    });
    try {
      const r = await fetch(`${server.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: [{ role: "user", content: "reply exactly: OK" }],
          stream: false,
          enable_thinking: false,
          max_tokens: 128,
          top_p: 1,
        }),
      });
      expect(r.status).toBe(200);
      expect(resets).toBe(1);
      expect(JSON.stringify(await r.json())).toContain("OK");
    } finally {
      pool.close();
      await server.stop(true);
      await session.close();
    }
  },
  240000,
);
