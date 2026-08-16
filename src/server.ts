import { timingSafeEqual } from "node:crypto";
import {
  createServer as httpCreate,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";
import { env, NAMESPACE } from "./constants.ts";
import type { TokenPool } from "./token-pool.ts";
import { transformStream } from "./translate.ts";
import type { CatalogEntry, ChatRequest, ModelRoute } from "./types.ts";
import type { Upstream } from "./upstream.ts";

export interface ServerDeps {
  pool: TokenPool;
  upstream: Upstream;
  model?: string;
  /** Allowed bearer keys; when omitted, falls back to env.apiKeys. Empty array disables auth. */
  apiKeys?: string[];
  port?: number;
  host?: string;
  /** Built at startup by `buildCatalog()`. Falls back to the default route when absent. */
  catalog?: CatalogEntry[];
  /** Mutable catalog source; when provided, the server reads it per request instead of the static `catalog`. */
  getCatalog?: () => CatalogEntry[];
  /** Dynamically resolved fallback deploy route for the default model, used when the catalog is empty. */
  defaultRoute?: ModelRoute;
}

export interface ServerInstance {
  port: number;
  hostname: string;
  stop: (closeActiveConnections?: boolean) => Promise<void>;
  url: string;
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
  code = type,
) => json({ error: { message, type, code } }, status);

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    void timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

export function isAuthorized(req: Request, keys: string[]): boolean {
  if (keys.length === 0) return true;
  const auth = req.headers.get("authorization");
  const m = auth ? /^bearer\s+(.+)$/i.exec(auth) : null;
  if (!m) return false;
  const token = (m[1] ?? "").trim();
  let ok = false;
  for (const k of keys) if (safeEqual(token, k)) ok = true;
  return ok;
}

/** Bridge a Web Request/Response handler to node:http's IncomingMessage/ServerResponse. */
function httpHandler(fetchHandler: (req: Request) => Promise<Response>) {
  return async (req: IncomingMessage, res: ServerResponse) => {
    req.setTimeout(0);
    const url = `http://${req.headers.host ?? "localhost"}${req.url}`;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(",") : v);
    }
    let body: string | null = null;
    if (
      req.method !== "GET" &&
      req.method !== "HEAD" &&
      req.method !== "OPTIONS"
    ) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      body = Buffer.concat(chunks).toString();
    }
    try {
      const response = await fetchHandler(
        new Request(url, { method: req.method, headers, body }),
      );
      const headerObj: Record<string, string> = {};
      response.headers.forEach((v, k) => {
        headerObj[k] = v;
      });
      res.writeHead(response.status, headerObj);
      if (response.body) {
        // DOM and node:stream/web define separate ReadableStream types; at
        // runtime they're the same Web Streams object.
        Readable.fromWeb(response.body as never).pipe(res);
      } else {
        res.end();
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: { message: "internal server error" } }),
        );
      }
    }
  };
}

export async function createServer(deps: ServerDeps): Promise<ServerInstance> {
  const model = deps.model ?? env.model;
  const apiKeys = deps.apiKeys ?? env.apiKeys;
  const staticCatalog = deps.catalog ?? [];
  const getCatalog = deps.getCatalog ?? (() => staticCatalog);

  const lookup = (id: string) => getCatalog().find((m) => m.id === id);

  const handleFetch = async (req: Request) => {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    if (apiKeys.length > 0 && !isAuthorized(req, apiKeys)) {
      return errorJson(
        "Invalid API key",
        401,
        "invalid_request_error",
        "invalid_api_key",
      );
    }

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

    const body = parseBody(await req.text());
    if (!body) {
      return errorJson("messages must be a non-empty array", 400);
    }
    if (body.messages.some((m) => !m?.role)) {
      return errorJson("each message must have a role", 400);
    }
    for (const m of body.messages) {
      if (m.content == null) m.content = "";
    }

    const stream = body.stream !== false;
    const reqModel = body.model ?? model;

    const catalog = getCatalog();
    if (catalog.length > 0 && !lookup(reqModel)) {
      return errorJson(`model '${reqModel}' not found`, 404, "model_not_found");
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

    // A rejected token (expired or blocked) yields a client error that mentions
    // the captcha; other statuses are returned as-is. Retry with a fresh token.
    const isTokenRejection = (status: number, text: string) =>
      (status === 400 || status === 401 || status === 403) &&
      /captcha|hcaptcha|token/i.test(text);

    const MAX_TOKEN_RETRIES = 2;
    let up: Response | null = null;
    let lastUpstreamError: { status: number; text: string } | null = null;
    for (let attempt = 0; attempt <= MAX_TOKEN_RETRIES; attempt++) {
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

      let res: Response;
      try {
        res = await deps.upstream.chat({
          token,
          messages: body.messages,
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

      if (res.ok) {
        up = res;
        break;
      }
      const text = await res.text().catch(() => "");
      lastUpstreamError = { status: res.status, text };
      if (!isTokenRejection(res.status, text)) break;
    }

    if (!up) {
      return errorJson(
        `upstream ${lastUpstreamError?.status}: ${lastUpstreamError?.text.slice(0, 500)}`,
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
  };

  const port = deps.port ?? env.port;
  const hostname = deps.host ?? env.host;

  const handler = httpHandler(handleFetch);
  const server = await new Promise<Server>((resolve, reject) => {
    const s = httpCreate(handler);
    s.on("error", reject);
    s.listen(port, hostname, () => resolve(s));
  });
  const addr = server.address() as AddressInfo;

  return {
    port: addr.port,
    hostname,
    url: `http://${hostname}:${addr.port}`,
    stop: async (closeActiveConnections?: boolean) => {
      if (closeActiveConnections) server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
