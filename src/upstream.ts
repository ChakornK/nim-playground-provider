import { ORIGIN, REFERER, UPSTREAM_BASE, USER_AGENT } from "./constants";
import type { OpenAIMessage, UpstreamChatParams } from "./types";

export function upstreamUrl(modelId: string): string {
  return `${UPSTREAM_BASE}/models/${modelId}`;
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
}) {
  return {
    stream: params.stream,
    chat_template_kwargs: {
      enable_thinking: params.enableThinking,
      clear_thinking: false,
    },
    model: params.model,
    temperature: params.temperature ?? 1,
    top_p: params.topP ?? 1,
    max_tokens: params.maxTokens ?? 16384,
    messages: params.messages,
    ...(params.tools?.length ? { tools: params.tools } : {}),
    ...(params.stream
      ? {
          stream_options: { include_usage: true, continuous_usage_stats: true },
        }
      : {}),
  };
}

/**
 * GLM wire convention for carrying cached reasoning into a conversation:
 * the model reads ` thinking ...\n response ...` as prior assistant thought.
 */
export function formatThinking(reasoning: string, answer: string): string {
  return ` thinking\n${reasoning}\n response\n${answer}`;
}

export class Upstream {
  /** Fetch a completion from NVIDIA. Resolves once headers arrive; body is consumed by caller. */
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
    });

    return fetch(upstreamUrl(route.modelId), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
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
