import { env } from "./constants";
import type { TokenPool } from "./token-pool";
import { transformStream } from "./translate";
import type { ChatRequest } from "./types";
import type { Upstream } from "./upstream";

export interface ServerDeps {
  pool: TokenPool;
  upstream: Upstream;
  model?: string;
  port?: number;
}

export function parseBody(raw: unknown): ChatRequest | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  try {
    const obj = JSON.parse(raw) as ChatRequest;
    if (
      !obj ||
      typeof obj !== "object" ||
      !Array.isArray(obj.messages) ||
      obj.messages.length === 0
    ) {
      return null;
    }
    return obj;
  } catch {
    return null;
  }
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-headers":
    "content-type, authorization, openai-organization, openai-project",
  "access-control-allow-methods": "GET, POST, OPTIONS",
};

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
  ...CORS,
};

const json = (obj: unknown, status: number) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...CORS },
  });

const errorJson = (
  message: string,
  status: number,
  type = "invalid_request_error",
) => json({ error: { message, type, code: type } }, status);

export function createServer(deps: ServerDeps) {
  const model = deps.model ?? env.model;

  return Bun.serve({
    port: deps.port ?? env.port,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS")
        return new Response(null, { headers: CORS });

      if (req.method === "GET" && url.pathname === "/v1/models") {
        return json(
          { object: "list", data: [{ id: model, object: "model" }] },
          200,
        );
      }

      if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
        return errorJson("Not found", 404, "not_found");
      }

      server.timeout(req, 0);

      const body = parseBody(await req.text());
      if (!body) {
        return errorJson("messages must be a non-empty array", 400);
      }
      if (
        body.messages.some(
          (m) =>
            !m?.role || (m.content != null && typeof m.content !== "string"),
        )
      ) {
        return errorJson("each message must have a string content", 400);
      }

      const stream = body.stream !== false;
      const reqModel = body.model ?? model;

      let token: string;
      try {
        token = await deps.pool.acquire();
      } catch (e) {
        return errorJson(
          `captcha solver unavailable: ${(e as Error).message}`,
          503,
          "server_error",
        );
      }

      let up: Response;
      try {
        up = await deps.upstream.chat({
          token,
          messages: body.messages,
          model: reqModel,
          temperature: body.temperature,
          topP: body.top_p,
          maxTokens: body.max_tokens,
          enableThinking: body.enable_thinking !== false,
          stream,
          tools: body.tools,
        });
      } catch (e) {
        return errorJson((e as Error).message, 502, "upstream_error");
      }

      if (!up.ok) {
        const text = await up.text().catch(() => "");
        return errorJson(
          `upstream ${up.status}: ${text.slice(0, 500)}`,
          502,
          "upstream_error",
        );
      }

      if (!stream) {
        const completion = (await up.json()) as Record<string, unknown>;
        completion.id = `chatcmpl-${crypto.randomUUID()}`;
        return json(completion, 200);
      }

      // streaming
      const streamOut = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          try {
            for await (const frame of transformStream(
              up.body as ReadableStream<Uint8Array>,
            )) {
              controller.enqueue(enc.encode(frame));
            }
          } catch {
            // upstream dropped mid-stream; close without a partial [DONE]
          } finally {
            try {
              controller.close();
            } catch {}
          }
        },
      });
      return new Response(streamOut, { status: 200, headers: SSE_HEADERS });
    },
  });
}
