import { parseSSE } from "./sse.ts";
import type { OpenAIChunk } from "./types.ts";

/**
 * Transform upstream SSE frames into OpenAI SSE.
 *
 * Upstream sends `usage` on every frame; strict OpenAI clients expect it on at
 * most the final frame. We hold back one frame (lookahead) and emit it stripped,
 * only keeping `usage` on the last frame before [DONE].
 */
export async function* transformStream(
  upstreamBody: ReadableStream<Uint8Array>,
  onChunk?: (chunk: OpenAIChunk) => void,
): AsyncGenerator<string> {
  let held: OpenAIChunk | null = null;

  const flush = function* (keepUsage: boolean) {
    if (!held) return;
    const chunk = held;
    held = null;
    if (!keepUsage) delete chunk.usage;
    yield `data: ${JSON.stringify(chunk)}\n\n`;
  };

  for await (const payload of parseSSE(upstreamBody)) {
    if (payload === "[DONE]") {
      yield* flush(true);
      yield "data: [DONE]\n\n";
      continue;
    }
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      continue; // drop malformed frames rather than killing the stream
    }
    if (!obj || typeof obj !== "object") continue;
    if (
      typeof obj.object !== "string" ||
      obj.object !== "chat.completion.chunk"
    ) {
      continue;
    }
    const chunk = obj as unknown as OpenAIChunk;
    onChunk?.(chunk);
    // emit the previous frame (stripped), then hold this one
    yield* flush(false);
    held = chunk;
  }
  // stream ended without [DONE]: emit anything held with usage intact
  yield* flush(true);
}
