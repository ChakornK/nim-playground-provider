import { parseSSE } from "./sse.ts";
import type { OpenAIChunk } from "./types.ts";

export interface StreamMeta {
  /** Set when a chunk carries a non-null finish_reason. */
  finishReason: string | null;
}

/** SSE error frame terminating a stream that ended before finish_reason. */
export const STREAM_ERROR_FRAME = `data: ${JSON.stringify({
  error: {
    message: "upstream stream ended before finish_reason",
    type: "upstream_error",
    code: "stream_incomplete",
  },
})}\n\n`;

/** Transform upstream SSE frames into OpenAI SSE. Upstream sends usage on every
 * frame, strict OpenAI clients want it only on the final frame. Hold one frame
 * (lookahead), emit it stripped, keep usage only on the last frame before [DONE]. */
export async function* transformStream(
  upstreamBody: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  meta?: StreamMeta,
): AsyncGenerator<string> {
  let held: OpenAIChunk | null = null;
  let sawFinish = false;

  const flush = function* (keepUsage: boolean) {
    if (!held) return;
    const chunk = held;
    held = null;
    if (!keepUsage) delete chunk.usage;
    yield `data: ${JSON.stringify(chunk)}\n\n`;
  };

  for await (const payload of parseSSE(upstreamBody, signal)) {
    if (payload === "[DONE]") {
      yield* flush(true);
      yield "data: [DONE]\n\n";
      return;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue; // drop malformed frames, don't kill the stream
    }
    if (!obj || typeof obj !== "object") continue;
    if (
      typeof obj.object !== "string" ||
      obj.object !== "chat.completion.chunk"
    ) {
      continue;
    }
    const chunk = obj as unknown as OpenAIChunk;
    const finish = chunk.choices?.[0]?.finish_reason;
    if (typeof finish === "string") {
      sawFinish = true;
      if (meta) meta.finishReason = finish;
    }
    // emit the previous frame (stripped), then hold this one
    yield* flush(false);
    held = chunk;
  }
  // stream ended without [DONE], emit anything held with usage intact
  yield* flush(true);
  if (signal?.aborted) return;
  if (!sawFinish) {
    // Terminate with an error frame instead of [DONE] so clients surface a
    // typed, coded error instead of a bare "Stream ended without
    // finish_reason" or "terminated".
    yield STREAM_ERROR_FRAME;
    return;
  }
  yield "data: [DONE]\n\n";
}
