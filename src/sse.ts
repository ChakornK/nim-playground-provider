/**
 * Minimal SSE parser. Yields event data strings (the part after "data: ").
 * Handles LF / CRLF line endings, ignores blank lines and comment lines.
 */
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      // split on \n (SSE spec uses LF; tolerate CRLF by trimming \r)
      let idx = buf.indexOf("\n");
      while (idx !== -1) {
        const line = buf.slice(0, idx).replace(/\r$/, "");
        buf = buf.slice(idx + 1);
        if (line.startsWith("data:")) {
          const data = line.slice(5).trimStart();
          if (data.length > 0) yield data;
        }
        // blank line = event boundary; we yield per-data-line so no need to act here
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
    reader.releaseLock();
  }
}
