import type { OpenAIMessage } from "./types";

export const HCAPTCHA_SITEKEY = "0c6a1e45-75d7-43cc-b836-a0c9d886b8ee";
export const HCAPTCHA_API =
  "https://js.hcaptcha.com/1/api.js?render=explicit&onload=__hcLoad";
export const BLANK_ORIGIN = "https://build.nvidia.com/z-ai/glm-5.2";

export const DEFAULT_MODEL = "z-ai/glm-5.2";
export const DEFAULT_MODEL_ID = "qc69jvmznzxy/glm-5.2"; // NVIDIA deployment path segment
export const DEFAULT_FUNCTION_ID = "3b9748d8-1d85-40e8-8573-0eeaa63a4b63"; // NVIDIA queue function id
export const UPSTREAM_BASE = "https://api.ngc.nvidia.com/v2/predict";
export const ORIGIN = "https://build.nvidia.com";
export const REFERER = "https://build.nvidia.com/";

const num = (v: string | undefined, dflt: number): number => {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

export const env = {
  port: num(process.env.PORT, 8787),
  poolSize: Math.max(1, Math.trunc(num(process.env.POOL_SIZE, 2))),
  chromiumPath: process.env.CHROMIUM_PATH,
  modelId: process.env.NVIDIA_MODEL_ID ?? DEFAULT_MODEL_ID,
  functionId: process.env.NVIDIA_FUNCTION_ID ?? DEFAULT_FUNCTION_ID,
  model: process.env.MODEL ?? DEFAULT_MODEL,
};

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
