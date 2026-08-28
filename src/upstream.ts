import { ORIGIN, REFERER, UPSTREAM_BASE, USER_AGENT } from "./constants.ts";
import type { OpenAIMessage, UpstreamChatParams } from "./types.ts";

export function upstreamUrl(modelId: string): string {
  return `${UPSTREAM_BASE}/models/${modelId}`;
}

const DEFAULT_TEMPERATURE = 1;
const DEFAULT_TOP_P = 1;
const DEFAULT_MAX_TOKENS = 16384;

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
    .map(([key]) => key);
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
    ...(allowed("temperature")
      ? { temperature: params.temperature ?? DEFAULT_TEMPERATURE }
      : {}),
    ...(allowed("top_p") ? { top_p: params.topP ?? DEFAULT_TOP_P } : {}),
    ...(allowed("max_tokens")
      ? { max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS }
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

    return fetch(upstreamUrl(route.modelId), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        // undici corrupts zstd bodies, so only offer gzip/br.
        "accept-encoding": "gzip, br",
        origin: ORIGIN,
        referer: REFERER,
        "user-agent": USER_AGENT,
        "nv-captcha-token": params.token,
        "nv-function-id": route.functionId,
      },
      body: JSON.stringify(body),
    });
  }
}
