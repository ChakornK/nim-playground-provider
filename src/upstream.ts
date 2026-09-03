import { ORIGIN, REFERER, UPSTREAM_BASE, USER_AGENT } from "./constants.ts";
import type { FetchLike } from "./route-fetch.ts";
import type { OpenAIMessage, UpstreamChatParams } from "./types.ts";

export function upstreamUrl(modelId: string): string {
  return `${UPSTREAM_BASE}/models/${modelId}`;
}

const DEFAULT_HEADERS_TIMEOUT_MS = 120_000;

const dropsLogged = new Set<string>();

export interface UpstreamOpts {
  headersTimeoutMs?: number;
  fetchImpl?: FetchLike;
}

export class UpstreamHeadersTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`upstream response headers timed out after ${timeoutMs}ms`);
    this.name = "UpstreamHeadersTimeoutError";
  }
}

export class UpstreamBodyTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`upstream response body timed out after ${timeoutMs}ms`);
    this.name = "UpstreamBodyTimeoutError";
  }
}

const requestAbortError = (): Error => {
  if (typeof DOMException !== "undefined") {
    return new DOMException("request aborted", "AbortError");
  }
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
};

export interface ReadBodyOpts {
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes?: number;
}

/** Read a response body within a bounded deadline and size. */
export async function readTextBody(
  response: Response,
  opts: ReadBodyOpts,
): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new SyntaxError("upstream response body is empty");
  const maxBytes = opts.maxBytes ?? 16 * 1024 * 1024;
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let complete = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;

  const interrupted = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new UpstreamBodyTimeoutError(opts.timeoutMs)),
      opts.timeoutMs,
    );
    timer.unref();
    onAbort = () => reject(requestAbortError());
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
  });
  const reading = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error("upstream response body too large");
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    complete = true;
    return text;
  })();

  try {
    return await Promise.race([reading, interrupted]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
    if (!complete) void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {}
  }
}

/** Read and parse a bounded non-streaming JSON response. */
export async function readJsonBody(
  response: Response,
  opts: ReadBodyOpts,
): Promise<unknown> {
  return JSON.parse(await readTextBody(response, opts)) as unknown;
}

export function buildUpstreamBody(params: {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  enableThinking: boolean;
  stream: boolean;
  tools?: unknown[];
  /** Params the model accepts; others are dropped. Undefined = allow all. */
  allowedParams?: string[];
}) {
  const allowed = (key: string) =>
    !params.allowedParams || params.allowedParams.includes(key);
  const dropped = (
    [
      ["temperature", params.temperature],
      ["top_p", params.topP],
      ["max_tokens", params.maxTokens],
    ] as const
  )
    .filter(([key, v]) => v !== undefined && !allowed(key))
    .map(([key]) => key)
    .filter((key) => {
      // Log each unsupported param once per model.
      const seenKey = `${params.model}${key}`;
      if (dropsLogged.has(seenKey)) return false;
      dropsLogged.add(seenKey);
      return true;
    });
  if (dropped.length > 0) {
    console.warn(
      `[upstream] ${params.model}: dropping unsupported params: ${dropped.join(", ")}`,
    );
  }
  return {
    stream: params.stream,
    chat_template_kwargs: {
      enable_thinking: params.enableThinking,
      clear_thinking: false,
    },
    model: params.model,
    ...(params.temperature !== undefined && allowed("temperature")
      ? { temperature: params.temperature }
      : {}),
    ...(params.topP !== undefined && allowed("top_p")
      ? { top_p: params.topP }
      : {}),
    ...(params.maxTokens !== undefined && allowed("max_tokens")
      ? { max_tokens: params.maxTokens }
      : {}),
    messages: params.messages,
    ...(params.tools?.length ? { tools: params.tools } : {}),
    ...(params.stream
      ? {
          stream_options: { include_usage: true, continuous_usage_stats: true },
        }
      : {}),
  };
}

export class Upstream {
  private readonly headersTimeoutMs: number;
  private readonly fetchImpl: FetchLike;

  constructor(opts: UpstreamOpts = {}) {
    this.headersTimeoutMs = opts.headersTimeoutMs ?? DEFAULT_HEADERS_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  }

  /** Fetch a completion from NVIDIA. Resolves when headers arrive, caller consumes the body. */
  async chat(params: UpstreamChatParams): Promise<Response> {
    const route = params.route;
    const body = buildUpstreamBody({
      model: params.model,
      messages: params.messages,
      temperature: params.temperature,
      topP: params.topP,
      maxTokens: params.maxTokens,
      enableThinking: params.enableThinking,
      stream: params.stream,
      tools: params.tools,
      allowedParams: params.allowedParams,
    });

    const ctrl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctrl.abort(params.signal?.reason);
    if (params.signal?.aborted) onAbort();
    else params.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, this.headersTimeoutMs);
    timer.unref();
    try {
      params.onDispatch?.();
      return await this.fetchImpl(upstreamUrl(route.modelId), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: params.stream ? "text/event-stream" : "application/json",
          // undici corrupts zstd bodies, so only offer gzip/br.
          "accept-encoding": "gzip, br",
          origin: ORIGIN,
          referer: REFERER,
          "user-agent": USER_AGENT,
          "nv-captcha-token": params.token,
          "nv-function-id": route.functionId,
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: ctrl.signal,
      });
    } catch (error) {
      if (timedOut && error instanceof Error && error.name === "AbortError") {
        throw new UpstreamHeadersTimeoutError(this.headersTimeoutMs);
      }
      throw error;
    } finally {
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
    }
  }
}
