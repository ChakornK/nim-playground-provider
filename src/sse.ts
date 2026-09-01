/** Minimal SSE parser. Yields event data strings (after "data: "),
 * handles LF/CRLF, ignores blank and comment lines. Aborting the signal
 * cancels the underlying stream. */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const onAbort = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort);
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // split on \n (SSE uses LF, tolerate CRLF by trimming \r)
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trimStart();
          if (data.length > 0) yield data;
        }
        idx = buf.indexOf("\n");
      }
    }
    // tail without trailing newline
    if (buf.length > 0) {
      const line = buf.replace(/\r$/, "");
      if (line.startsWith("data:")) {
        const data = line.slice(5).trimStart();
        if (data.length > 0) yield data;
      }
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
    // Cleanup is best-effort so a broken cancel hook cannot pin the consumer.
    void reader.cancel().catch(() => {});
    try {
      reader.releaseLock();
    } catch {}
  }
}
