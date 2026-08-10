import { buildUpstreamBody, ORIGIN, REFERER, upstreamUrl } from "./constants";
import type { UpstreamChatParams } from "./types";

export interface UpstreamRoute {
  modelId: string;
  functionId: string;
}

export class Upstream {
  constructor(private opts: UpstreamRoute) {}

  /** Fetch a completion from NVIDIA. Resolves once headers arrive; body is consumed by caller. */
  async chat(params: UpstreamChatParams): Promise<Response> {
    const route = params.route ?? this.opts;
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
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
        "nv-captcha-token": params.token,
        "nv-function-id": route.functionId,
      },
      body: JSON.stringify(body),
    });
  }
}
