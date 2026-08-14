// playwright-core's `ws`-based CDP transport hangs under Bun. This wraps
// Bun's native WebSocket as a Playwright ConnectionTransport instead.
export class BunCDPTransport {
  onmessage?: (message: object) => void;
  onclose?: (reason?: string) => void;
  private ws: WebSocket;

  private constructor(url: string) {
    this.ws = new WebSocket(url);
  }

  static connect(url: string): Promise<BunCDPTransport> {
    return new Promise((resolve, reject) => {
      const t = new BunCDPTransport(url);
      t.ws.addEventListener("open", () => resolve(t));
      t.ws.addEventListener("error", (e) =>
        reject(new Error(`ws error: ${(e as ErrorEvent).message ?? e}`)),
      );
      t.ws.addEventListener("message", (e) => {
        const data = (e as MessageEvent).data;
        // Defer so Playwright attaches onmessage after connect() resolves.
        queueMicrotask(() => t.onmessage?.(JSON.parse(data) as object));
      });
      t.ws.addEventListener("close", (e) =>
        t.onclose?.((e as CloseEvent).reason),
      );
    });
  }

  send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  close(): void {
    this.ws.close();
  }
}
