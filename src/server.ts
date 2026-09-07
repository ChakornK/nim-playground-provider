import { timingSafeEqual } from "node:crypto";
import { Elysia } from "elysia";
import { env, NAMESPACE } from "./constants.ts";
import {
  AllRoutesCoolingError,
  createDirectEgressCoordinator,
  EgressClosedError,
  type EgressCoordinator,
  EgressPreparationError,
  type GenerationLease,
  type GenerationOutcome,
} from "./egress.ts";
import {
  type RequestLease,
  RequestScheduler,
  type RequestStartPermit,
  SchedulerBackoffError,
  SchedulerClosedError,
  SchedulerQueueFullError,
} from "./scheduler.ts";
import type { TokenPool } from "./token-pool.ts";
import {
  STREAM_ERROR_FRAME,
  type StreamMeta,
  transformStream,
} from "./translate.ts";
import type { CatalogEntry, ChatRequest, ModelRoute } from "./types.ts";
import {
  readJsonBody,
  readTextBody,
  type Upstream,
  UpstreamBodyTimeoutError,
  UpstreamHeadersTimeoutError,
} from "./upstream.ts";

export interface ServerDeps {
  pool?: TokenPool;
  upstream?: Upstream;
  egress?: EgressCoordinator;
  model?: string;
  /** Allowed bearer keys, falls back to env.apiKeys if omitted. Empty array disables auth. */
  apiKeys?: string[];
  port?: number;
  host?: string;
  /** Built at startup by buildCatalog(), falls back to default route when absent. */
  catalog?: CatalogEntry[];
  /** Mutable catalog source, read per request instead of the static catalog when set. */
  getCatalog?: () => CatalogEntry[];
  /** Fallback deploy route for the default model, used when the catalog is empty. */
  defaultRoute?: ModelRoute;
  /** Read per request when set, so a route resolved after startup takes effect. */
  getDefaultRoute?: () => ModelRoute | undefined;
  /** Maximum generations allowed to occupy NVIDIA concurrently. */
  upstreamConcurrency?: number;
  /** Minimum delay between request starts sent to NVIDIA. */
  upstreamMinIntervalMs?: number;
  /** Initial delay imposed after NVIDIA overloads or times out. */
  upstreamBackoffMs?: number;
  /** Maximum delay after repeated upstream failures. */
  upstreamMaxBackoffMs?: number;
  /** Maximum wait for a non-streaming NVIDIA response body. */
  upstreamBodyTimeoutMs?: number;
  /** Maximum idle period between NVIDIA stream frames. */
  upstreamStreamIdleTimeoutMs?: number;
  /** Maximum number of requests waiting for an NVIDIA concurrency slot. */
  upstreamMaxQueue?: number;
}

export interface ServerInstance {
  port: number;
  hostname: string;
  beginShutdown(): void;
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

const json = (obj: unknown, status: number, headers?: HeadersInit) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const errorJson = (
  message: string,
  status: number,
  type = "invalid_request_error",
  code = type,
  headers?: HeadersInit,
) => json({ error: { message, type, code } }, status, headers);

/** Logs an upstream_error and returns its message for the response body. */
const logUpstreamError = (message: string): string => {
  console.error(`[server] upstream_error: ${message}`);
  return message;
};

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

// This terminal validation response is the only post-dispatch retry path.
const isTokenRejection = (status: number, text: string) =>
  status === 400 &&
  /(?:invalid captcha token|\btoken\s+is\s+invalid\b)/i.test(text);

const MAX_TOKEN_RETRIES = 1;
const MAX_ROUTE_ATTEMPTS = 3;
const TOKEN_ACQUISITION_DEADLINE_MS = 60_000;

class CaptchaAcquireTimeoutError extends Error {
  constructor() {
    super("timed out waiting for a captcha token");
    this.name = "CaptchaAcquireTimeoutError";
  }
}

const retryAfterMs = (response: Response): number | null => {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - Date.now());
};

const isAmbiguousProviderIpFailure = (status: number): boolean =>
  status === 403 || status === 429;

const isProviderGlobalFailure = (status: number): boolean => status >= 500;

const MAX_BODY_BYTES = 4 * 1024 * 1024;

const oversized = () =>
  errorJson(
    "request body too large",
    413,
    "invalid_request_error",
    "request_too_large",
  );

export async function createServer(deps: ServerDeps): Promise<ServerInstance> {
  const model = deps.model ?? env.model;
  const apiKeys = deps.apiKeys ?? env.apiKeys;
  const staticCatalog = deps.catalog ?? [];
  const getCatalog = deps.getCatalog ?? (() => staticCatalog);
  const upstreamBackoffMs = deps.upstreamBackoffMs ?? env.upstreamBackoffMs;
  const upstreamMaxBackoffMs =
    deps.upstreamMaxBackoffMs ?? env.upstreamMaxBackoffMs;
  const upstreamBodyTimeoutMs =
    deps.upstreamBodyTimeoutMs ?? env.upstreamBodyTimeoutMs;
  const upstreamStreamIdleTimeoutMs =
    deps.upstreamStreamIdleTimeoutMs ?? env.upstreamStreamIdleTimeoutMs;
  const egress =
    deps.egress ??
    (deps.pool && deps.upstream
      ? createDirectEgressCoordinator(deps.pool, deps.upstream)
      : null);
  if (!egress) {
    throw new Error("server requires egress or pool and upstream dependencies");
  }
  const scheduler = new RequestScheduler({
    concurrency: deps.upstreamConcurrency ?? env.upstreamConcurrency,
    minIntervalMs: deps.upstreamMinIntervalMs ?? env.upstreamMinIntervalMs,
    maxQueue: deps.upstreamMaxQueue,
  });
  let upstreamFailureStreak = 0;
  const imposeBackoff = (minimumMs = 0): number => {
    const exponential =
      upstreamBackoffMs * 2 ** Math.min(10, upstreamFailureStreak);
    upstreamFailureStreak++;
    const delay = Math.min(
      upstreamMaxBackoffMs,
      Math.max(minimumMs, exponential),
    );
    const applied = scheduler.backoff(delay);
    console.warn(`[server] provider cooldown (duration=${applied}ms)`);
    return applied;
  };
  const markUpstreamHealthy = () => {
    upstreamFailureStreak = 0;
  };
  const cooldownError = (error: { message: string; retryAfterMs: number }) =>
    errorJson(error.message, 429, "rate_limit_error", "upstream_cooldown", {
      "retry-after": String(Math.max(1, Math.ceil(error.retryAfterMs / 1_000))),
    });
  let shuttingDown = false;

  const handleFetch = async (req: Request) => {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    if (req.method === "GET" && url.pathname === "/health") {
      return new Response("OK", {
        status: 200,
        headers: { "content-type": "text/plain" },
      });
    }

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
          : [
              {
                id: model,
                object: "model",
                created: 0,
                owned_by: model.split("/")[0],
              },
            ];
      return json({ object: "list", data }, 200);
    }

    if (url.pathname !== "/v1/chat/completions" || req.method !== "POST") {
      return errorJson("Not found", 404, "not_found");
    }

    // Always drain the body fully before responding: replying mid-upload races
    // the client into reusing a socket whose leftover bytes then parse as the
    // next request's headers (431) or RST the unread response.
    const rawBody = await req.text();
    if (shuttingDown) {
      return errorJson(
        "server is shutting down",
        503,
        "server_error",
        "server_shutting_down",
      );
    }
    if (
      rawBody.length > MAX_BODY_BYTES ||
      Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES
    ) {
      return oversized();
    }
    const body = parseBody(rawBody);
    if (!body) {
      return errorJson("messages must be a non-empty array", 400);
    }
    if (body.messages.some((m) => !m?.role)) {
      return errorJson("each message must have a role", 400);
    }
    for (const m of body.messages) {
      if (m.content == null) m.content = "";
    }

    const stream = body.stream === true;
    const reqModel = body.model ?? model;
    const catalog = getCatalog();
    const entry =
      catalog.length > 0 ? catalog.find((m) => m.id === reqModel) : undefined;
    // The default model stays routable via its fallback route; other unknown
    // models are rejected.
    if (!entry && reqModel !== model) {
      return errorJson(
        `model '${reqModel}' not found`,
        404,
        "invalid_request_error",
        "model_not_found",
      );
    }
    const fallbackRoute = deps.getDefaultRoute?.() ?? deps.defaultRoute;
    const route = entry
      ? {
          modelId: `${entry.namespace ?? NAMESPACE}/${entry.slug}`,
          functionId: entry.functionId,
          params: entry.params,
          reasoningEfforts: entry.reasoningEfforts,
        }
      : fallbackRoute;
    if (!route) {
      return errorJson(
        `no route available for model '${reqModel}'`,
        503,
        "server_error",
      );
    }

    let lease: RequestLease;
    try {
      lease = await scheduler.acquire(req.signal);
    } catch (e) {
      const error = e instanceof Error ? e : new Error(String(e));
      if (error instanceof SchedulerBackoffError) return cooldownError(error);
      if (error instanceof SchedulerClosedError) {
        return errorJson(
          "server is shutting down",
          503,
          "server_error",
          "server_shutting_down",
        );
      }
      if (error.name === "AbortError") {
        return errorJson(
          "request cancelled while waiting for NVIDIA",
          499,
          "request_cancelled",
        );
      }
      const queueFull = error instanceof SchedulerQueueFullError;
      return errorJson(
        error.message,
        queueFull ? 503 : 500,
        "server_error",
        queueFull ? "upstream_queue_full" : "internal_error",
      );
    }

    let releaseLease: (() => void) | null = lease.release;
    let generation: GenerationLease | null = null;
    let routeAttempts = 0;
    const tokenDeadlineAt = Date.now() + TOKEN_ACQUISITION_DEADLINE_MS;
    const finishGeneration = async (outcome: GenerationOutcome) => {
      const current = generation as GenerationLease | null;
      generation = null;
      await current?.finish(outcome);
    };
    const getGeneration = (): GenerationLease => {
      const current = generation as GenerationLease | null;
      if (!current) throw new EgressPreparationError();
      return current;
    };
    const acquireGenerationToken = async (): Promise<string> => {
      let lastError: unknown;
      while (routeAttempts < MAX_ROUTE_ATTEMPTS) {
        if (!generation) {
          routeAttempts++;
          try {
            generation = await egress.acquire(req.signal);
          } catch (error) {
            lastError = error;
            if (error instanceof EgressPreparationError) continue;
            throw error;
          }
        }
        const remaining = tokenDeadlineAt - Date.now();
        if (remaining <= 0) throw new CaptchaAcquireTimeoutError();
        const deadline = new AbortController();
        const timer = setTimeout(() => deadline.abort(), remaining);
        timer.unref();
        try {
          return await generation.acquireToken(
            AbortSignal.any([req.signal, deadline.signal]),
          );
        } catch (error) {
          if (req.signal.aborted) throw error;
          lastError = deadline.signal.aborted
            ? new CaptchaAcquireTimeoutError()
            : error;
          await finishGeneration("pre_dispatch_route_failure");
          if (deadline.signal.aborted) throw lastError;
        } finally {
          clearTimeout(timer);
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new EgressPreparationError();
    };
    try {
      let up: Response | null = null;
      let lastUpstreamError: { status: number; text: string } | null = null;
      let lastWasRejection = false;
      let lastBackoffMs: number | null = null;
      for (let attempt = 0; attempt <= MAX_TOKEN_RETRIES; attempt++) {
        let token: string;
        while (true) {
          let startPermit: RequestStartPermit;
          try {
            startPermit = await lease.waitForStart(req.signal);
          } catch (e) {
            const error = e instanceof Error ? e : new Error(String(e));
            if (error instanceof SchedulerBackoffError) {
              return cooldownError(error);
            }
            if (error instanceof SchedulerClosedError) {
              return errorJson(
                "server is shutting down",
                503,
                "server_error",
                "server_shutting_down",
              );
            }
            return errorJson(
              "request cancelled before NVIDIA started",
              499,
              "request_cancelled",
            );
          }

          try {
            token = await acquireGenerationToken();
          } catch (e) {
            startPermit.cancel();
            const error = e instanceof Error ? e : new Error(String(e));
            if (
              error instanceof AllRoutesCoolingError ||
              error instanceof SchedulerBackoffError
            ) {
              return cooldownError(error);
            }
            if (
              shuttingDown ||
              error instanceof EgressClosedError ||
              error instanceof SchedulerClosedError
            ) {
              return errorJson(
                "server is shutting down",
                503,
                "server_error",
                "server_shutting_down",
              );
            }
            if (error.name === "AbortError") {
              return errorJson(
                "request cancelled while waiting for captcha",
                499,
                "request_cancelled",
              );
            }
            return errorJson(
              `captcha solver unavailable: ${error.message}`,
              503,
              "server_error",
            );
          }

          if (startPermit.markStarted()) break;
        }

        let res: Response;
        let mayHaveDispatched = false;
        try {
          const currentGeneration = getGeneration();
          mayHaveDispatched = true;
          res = await currentGeneration.chat({
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
            allowedParams: route.params,
            reasoningEfforts: route.reasoningEfforts,
            signal: req.signal,
            onDispatch: () => {
              mayHaveDispatched = true;
            },
          });
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          if (req.signal.aborted || error.name === "AbortError") {
            await finishGeneration("neutral");
            return errorJson(
              req.signal.aborted
                ? "request cancelled while NVIDIA was running"
                : logUpstreamError(error.message),
              req.signal.aborted ? 499 : 502,
              req.signal.aborted ? "request_cancelled" : "upstream_error",
            );
          }
          if (!mayHaveDispatched) {
            await finishGeneration("pre_dispatch_route_failure");
            continue;
          }
          await finishGeneration("ambiguous_post_dispatch_failure");
          const backoff = imposeBackoff();
          if (error instanceof UpstreamHeadersTimeoutError) {
            return errorJson(
              logUpstreamError(error.message),
              504,
              "upstream_error",
              "upstream_timeout",
              { "retry-after": String(Math.ceil(backoff / 1_000)) },
            );
          }
          return errorJson(
            logUpstreamError(error.message),
            502,
            "upstream_error",
            "upstream_error",
            { "retry-after": String(Math.ceil(backoff / 1_000)) },
          );
        }

        if (res.ok) {
          up = res;
          break;
        }
        let text: string;
        try {
          text = await readTextBody(res, {
            timeoutMs: upstreamBodyTimeoutMs,
            signal: req.signal,
            maxBytes: 1024 * 1024,
          });
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          if (req.signal.aborted || error.name === "AbortError") {
            await finishGeneration("neutral");
            return errorJson(
              "request cancelled while reading NVIDIA error",
              499,
              "request_cancelled",
            );
          }
          await finishGeneration("ambiguous_post_dispatch_failure");
          const backoff = imposeBackoff();
          if (error instanceof UpstreamBodyTimeoutError) {
            return errorJson(
              logUpstreamError(error.message),
              504,
              "upstream_error",
              "upstream_body_timeout",
              {
                "retry-after": String(Math.ceil(backoff / 1_000)),
              },
            );
          }
          return errorJson(
            logUpstreamError(error.message),
            502,
            "upstream_error",
            "upstream_error_body_invalid",
            { "retry-after": String(Math.ceil(backoff / 1_000)) },
          );
        }
        lastUpstreamError = { status: res.status, text };
        lastWasRejection = isTokenRejection(res.status, text);
        if (lastWasRejection) {
          if (attempt < MAX_TOKEN_RETRIES) {
            try {
              await getGeneration().invalidateCaptcha();
            } catch (e) {
              await finishGeneration("pre_dispatch_route_failure");
              return errorJson(
                `captcha reset failed: ${(e as Error).message}`,
                503,
                "server_error",
              );
            }
            console.warn(
              `[server] NVIDIA rejected a captcha token (attempt ${attempt + 1}/${MAX_TOKEN_RETRIES + 1}); reset browser and retrying once`,
            );
            continue;
          }
          await finishGeneration("definitive_captcha_rejection");
        } else if (isAmbiguousProviderIpFailure(res.status)) {
          await finishGeneration("ambiguous_post_dispatch_failure");
          lastBackoffMs = imposeBackoff(retryAfterMs(res) ?? 0);
        } else if (isProviderGlobalFailure(res.status)) {
          await finishGeneration("provider_global_failure");
          lastBackoffMs = imposeBackoff(retryAfterMs(res) ?? 0);
        } else {
          await finishGeneration("neutral");
          markUpstreamHealthy();
        }
        break;
      }

      if (!up) {
        const { status, text } = lastUpstreamError ?? {
          status: 502,
          text: "",
        };
        const isClientError =
          !lastWasRejection && status >= 400 && status < 500;
        const message = `upstream ${status}: ${text.slice(0, 500)}`;
        if (!isClientError) logUpstreamError(message);
        const headers =
          lastBackoffMs === null
            ? undefined
            : {
                "retry-after": String(Math.ceil(lastBackoffMs / 1_000)),
              };
        return errorJson(
          message,
          isClientError ? status : 502,
          isClientError ? "invalid_request_error" : "upstream_error",
          isClientError ? "invalid_request_error" : "upstream_error",
          headers,
        );
      }

      if (!stream) {
        let completion: Record<string, unknown>;
        try {
          completion = (await readJsonBody(up, {
            timeoutMs: upstreamBodyTimeoutMs,
            signal: req.signal,
          })) as Record<string, unknown>;
        } catch (e) {
          const error = e instanceof Error ? e : new Error(String(e));
          if (req.signal.aborted || error.name === "AbortError") {
            await finishGeneration("neutral");
            return errorJson(
              "request cancelled while reading NVIDIA response",
              499,
              "request_cancelled",
            );
          }
          const timedOut = error instanceof UpstreamBodyTimeoutError;
          await finishGeneration(
            timedOut
              ? "ambiguous_post_dispatch_failure"
              : "provider_global_failure",
          );
          const backoff = imposeBackoff();
          if (timedOut) {
            return errorJson(
              logUpstreamError(error.message),
              504,
              "upstream_error",
              "upstream_body_timeout",
              {
                "retry-after": String(Math.ceil(backoff / 1_000)),
              },
            );
          }
          return errorJson(
            "upstream returned a non-JSON body",
            502,
            "upstream_error",
            "upstream_error",
            { "retry-after": String(Math.ceil(backoff / 1_000)) },
          );
        }
        await finishGeneration("success");
        markUpstreamHealthy();
        completion.id = `chatcmpl-${crypto.randomUUID()}`;
        return json(completion, 200);
      }

      const upstreamAbort = new AbortController();
      const meta: StreamMeta = { finishReason: null };
      let clientGone = false;
      const streamGeneration = getGeneration();
      generation = null;
      const onGenerationAbort = () => upstreamAbort.abort();
      if (streamGeneration.signal.aborted) onGenerationAbort();
      else {
        streamGeneration.signal.addEventListener("abort", onGenerationAbort, {
          once: true,
        });
      }
      const releaseStreamLease = releaseLease;
      releaseLease = null;
      const streamOut = new ReadableStream<Uint8Array>({
        async start(controller) {
          const enc = new TextEncoder();
          let idleTimedOut = false;
          let errorSent = false;
          const sendStreamError = () => {
            if (clientGone || errorSent) return;
            errorSent = true;
            try {
              controller.enqueue(enc.encode(STREAM_ERROR_FRAME));
            } catch {}
          };
          const idle = setTimeout(() => {
            idleTimedOut = true;
            upstreamAbort.abort();
          }, upstreamStreamIdleTimeoutMs);
          idle.unref();
          try {
            for await (const frame of transformStream(
              up.body as ReadableStream<Uint8Array>,
              upstreamAbort.signal,
              meta,
            )) {
              idle.refresh();
              controller.enqueue(enc.encode(frame));
            }
            if (idleTimedOut && !meta.finishReason) sendStreamError();
          } catch {
            sendStreamError();
          } finally {
            clearTimeout(idle);
            streamGeneration.signal.removeEventListener(
              "abort",
              onGenerationAbort,
            );
            if (
              clientGone ||
              (shuttingDown && streamGeneration.signal.aborted)
            ) {
              await streamGeneration.finish("neutral");
            } else if (meta.finishReason) {
              await streamGeneration.finish("success");
              markUpstreamHealthy();
            } else {
              await streamGeneration.finish("ambiguous_post_dispatch_failure");
              imposeBackoff();
              console.warn(
                "[server] stream ended without finish_reason; backing off NVIDIA requests",
              );
            }
            releaseStreamLease();
            try {
              controller.close();
            } catch {}
          }
        },
        cancel() {
          clientGone = true;
          upstreamAbort.abort();
        },
      });
      return new Response(streamOut, { status: 200, headers: SSE_HEADERS });
    } finally {
      await finishGeneration("neutral");
      releaseLease?.();
    }
  };

  const port = deps.port ?? env.port;
  const hostname = deps.host ?? env.host;

  const app = new Elysia()
    .onError(({ error }) =>
      errorJson(
        error instanceof Error ? error.message : "internal server error",
        500,
        "server_error",
        "internal_error",
      ),
    )
    .all("/*", ({ request }) => handleFetch(request))
    .listen({ port, hostname });

  const server = app.server;
  if (!server) throw new Error("failed to start server");

  const actualPort = server.port ?? port;
  const beginShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    scheduler.close();
    egress.beginShutdown();
  };
  return {
    port: actualPort,
    hostname,
    url: `http://${hostname}:${actualPort}`,
    beginShutdown,
    stop: async (closeActiveConnections?: boolean) => {
      beginShutdown();
      await app.stop(closeActiveConnections);
    },
  };
}
