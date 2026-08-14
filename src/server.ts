import { env, NAMESPACE } from "./constants";
import { ThinkingCache } from "./thinking-cache";
import type { TokenPool } from "./token-pool";
import { transformStream } from "./translate";
import type {
  CatalogEntry,
  ChatCompletion,
  ChatRequest,
  ModelRoute,
} from "./types";
import type { Upstream } from "./upstream";

export interface ServerDeps {
  pool: TokenPool;
  upstream: Upstream;
  model?: string;
  port?: number;
  host?: string;
  cache?: ThinkingCache;
  /** Built at startup by `buildCatalog()`. Falls back to the default route when absent. */
  catalog?: CatalogEntry[];
  /** Mutable catalog source; when provided, the server reads it per request instead of the static `catalog`. */
  getCatalog?: () => CatalogEntry[];
  /** Dynamically resolved fallback deploy route for the default model, used when the catalog is empty. */
  defaultRoute?: ModelRoute;
}

function parseBody(raw: unknown): ChatRequest | null {
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

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  "x-accel-buffering": "no",
};

const json = (obj: unknown, status: number) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json" },
  });

const errorJson = (
  message: string,
  status: number,
  type = "invalid_request_error",
) => json({ error: { message, type, code: type } }, status);

export function createServer(deps: ServerDeps) {
  const model = deps.model ?? env.model;
  const staticCatalog = deps.catalog ?? [];
  const getCatalog = deps.getCatalog ?? (() => staticCatalog);
  const cache = deps.cache ?? new ThinkingCache();

  const lookup = (id: string) => getCatalog().find((m) => m.id === id);

  return Bun.serve({
    port: deps.port ?? env.port,
    hostname: deps.host ?? env.host,
    async fetch(req, server) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { status: 204 });

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const catalog = getCatalog();
        const data =
          catalog.length > 0
            ? catalog.map((m) => ({
                id: m.id,
                object: "model",
                created: m.created,
                owned_by: m.ownedBy,
              }))
            : [{ id: model, object: "model" }];
        return json({ object: "list", data }, 200);
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

      const catalog = getCatalog();
      if (catalog.length > 0 && !lookup(reqModel)) {
        return errorJson(
          `model '${reqModel}' not found`,
          404,
          "model_not_found",
        );
      }

      const entry = catalog.length > 0 ? lookup(reqModel) : undefined;
      const route = entry
        ? {
            modelId: `${NAMESPACE}/${entry.slug}`,
            functionId: entry.functionId,
          }
        : deps.defaultRoute;
      if (!route) {
        return errorJson(
          `no route available for model '${reqModel}'`,
          503,
          "server_error",
        );
      }

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
        const messages = cache.augment(body.messages);
        up = await deps.upstream.chat({
          token,
          messages,
          model: reqModel,
          route,
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
        const msg = (completion as { choices?: ChatCompletion["choices"] })
          .choices?.[0]?.message;
        cache.remember(
          body.messages,
          msg?.reasoning_content ?? "",
          msg?.content ?? "",
        );
        return json(completion, 200);
      }

      // streaming
      const streamOut = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          let reasoning = "";
          let answer = "";
          try {
            for await (const frame of transformStream(
              up.body as ReadableStream<Uint8Array>,
              (c) => {
                const d = c.choices?.[0]?.delta;
                if (d?.reasoning_content) reasoning += d.reasoning_content;
                if (d?.content) answer += d.content;
              },
            )) {
              controller.enqueue(enc.encode(frame));
            }
          } catch {
            // upstream dropped mid-stream; close without a partial [DONE]
          } finally {
            cache.remember(body.messages, reasoning, answer);
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
