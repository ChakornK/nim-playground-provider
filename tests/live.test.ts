import { expect, test } from "vitest";
import { BrowserSession } from "../src/browser.ts";
import { resolveModelRoute } from "../src/catalog.ts";
import { env } from "../src/constants.ts";
import { createServer } from "../src/server.ts";
import { TokenPool } from "../src/token-pool.ts";
import { Upstream } from "../src/upstream.ts";

const LIVE = !!process.env.NVIDIA_LIVE;

/** Real deploy route for the default model, resolved against the queue endpoint. */
const route = () => resolveModelRoute(env.model);

test.skipIf(!LIVE)(
  "live: streaming completion shows reasoning then content and terminates with [DONE]",
  async () => {
    const session = new BrowserSession({ lightpandaPath: env.lightpandaPath });
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
      await server.stop(true);
      await session.close();
    }
  },
  180000,
);

test.skipIf(!LIVE)(
  "live: tool call comes back as structured delta.tool_calls (not <tool_call> XML text)",
  async () => {
    const session = new BrowserSession({ lightpandaPath: env.lightpandaPath });
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
      // GLM's native XML must not leak into content
      expect(text).not.toContain("<tool_call>");
      const done = text.trim().endsWith("data: [DONE]");
      expect(done).toBe(true);
    } finally {
      await server.stop(true);
      await session.close();
    }
  },
  180000,
);

test.skipIf(!LIVE)(
  "live: non-streaming completion returns an aggregated chat.completion",
  async () => {
    const session = new BrowserSession({ lightpandaPath: env.lightpandaPath });
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
      await server.stop(true);
      await session.close();
    }
  },
  180000,
);
