import http from "node:http";
import net, { isIP, type Socket } from "node:net";
import type { ProxyDefinition } from "./proxy-list.ts";

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
const DEFAULT_IDLE_TIMEOUT_MS = 120_000;
const MAX_TARGET_HOST_BYTES = 255;

export interface SocksConnectAdapterOpts {
  connectTimeoutMs?: number;
  idleTimeoutMs?: number;
}

export class SocksNegotiationError extends Error {
  constructor() {
    super("SOCKS proxy negotiation failed");
    this.name = "SocksNegotiationError";
  }
}

function parseAuthority(authority: string): { host: string; port: number } {
  const ipv6 = /^\[([^\]]+)\]:(\d+)$/.exec(authority);
  const regular = /^([^:]+):(\d+)$/.exec(authority);
  const match = ipv6 ?? regular;
  if (!match) throw new Error("invalid CONNECT authority");
  const host = match[1] ?? "";
  const port = Number(match[2]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("invalid CONNECT authority");
  }
  return { host, port };
}

function waitReadable(socket: Socket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("readable", onReadable);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const onReadable = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new SocksNegotiationError());
    };
    const onClose = () => {
      cleanup();
      reject(new SocksNegotiationError());
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new SocksNegotiationError());
    }, timeoutMs);
    timer.unref();
    socket.once("readable", onReadable);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

async function readExactly(
  socket: Socket,
  size: number,
  timeoutMs: number,
  deadlineAt = Date.now() + timeoutMs,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let remaining = size;
  while (remaining > 0) {
    const chunk = socket.read(remaining) as Buffer | null;
    if (!chunk) {
      const waitMs = deadlineAt - Date.now();
      if (waitMs <= 0) throw new SocksNegotiationError();
      await waitReadable(socket, waitMs);
      continue;
    }
    chunks.push(chunk);
    remaining -= chunk.byteLength;
  }
  return chunks.length === 1 ? (chunks[0] as Buffer) : Buffer.concat(chunks);
}

function connectSocket(
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("connect", onConnect);
      socket.off("error", onError);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = () => {
      cleanup();
      socket.destroy();
      reject(new SocksNegotiationError());
    };
    const timer = setTimeout(onError, timeoutMs);
    timer.unref();
    socket.once("connect", onConnect);
    socket.once("error", onError);
  });
}

function ipv4Bytes(host: string): Buffer {
  return Buffer.from(host.split(".").map(Number));
}

function ipv6Bytes(host: string): Buffer {
  const halves = host.toLowerCase().split("::");
  if (halves.length > 2) throw new SocksNegotiationError();
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) {
    throw new SocksNegotiationError();
  }
  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) throw new SocksNegotiationError();
  const bytes = Buffer.alloc(16);
  for (const [index, group] of groups.entries()) {
    const value = Number.parseInt(group || "0", 16);
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new SocksNegotiationError();
    }
    bytes.writeUInt16BE(value, index * 2);
  }
  return bytes;
}

async function negotiateSocks4(
  socket: Socket,
  target: { host: string; port: number },
  timeoutMs: number,
): Promise<void> {
  const family = isIP(target.host);
  const hostBytes = Buffer.from(target.host, "utf8");
  if (family === 6 || hostBytes.byteLength > MAX_TARGET_HOST_BYTES) {
    throw new SocksNegotiationError();
  }
  const port = Buffer.alloc(2);
  port.writeUInt16BE(target.port);
  const address =
    family === 4 ? ipv4Bytes(target.host) : Buffer.from([0, 0, 0, 1]);
  const domain =
    family === 4
      ? Buffer.alloc(0)
      : Buffer.concat([hostBytes, Buffer.from([0])]);
  socket.write(
    Buffer.concat([
      Buffer.from([4, 1]),
      port,
      address,
      Buffer.from([0]),
      domain,
    ]),
  );
  const response = await readExactly(
    socket,
    8,
    timeoutMs,
    Date.now() + timeoutMs,
  );
  if (response[1] !== 0x5a) throw new SocksNegotiationError();
}

async function negotiateSocks5(
  socket: Socket,
  target: { host: string; port: number },
  timeoutMs: number,
): Promise<void> {
  const deadlineAt = Date.now() + timeoutMs;
  socket.write(Buffer.from([5, 1, 0]));
  const greeting = await readExactly(socket, 2, timeoutMs, deadlineAt);
  if (greeting[0] !== 5 || greeting[1] !== 0) {
    throw new SocksNegotiationError();
  }

  const family = isIP(target.host);
  let address: Buffer;
  if (family === 4) {
    address = Buffer.concat([Buffer.from([1]), ipv4Bytes(target.host)]);
  } else if (family === 6) {
    address = Buffer.concat([Buffer.from([4]), ipv6Bytes(target.host)]);
  } else {
    const domain = Buffer.from(target.host, "utf8");
    if (domain.byteLength === 0 || domain.byteLength > MAX_TARGET_HOST_BYTES) {
      throw new SocksNegotiationError();
    }
    address = Buffer.concat([Buffer.from([3, domain.byteLength]), domain]);
  }
  const port = Buffer.alloc(2);
  port.writeUInt16BE(target.port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, port]));

  const header = await readExactly(socket, 4, timeoutMs, deadlineAt);
  if (header[0] !== 5 || header[1] !== 0) throw new SocksNegotiationError();
  const addressType = header[3];
  if (addressType === 1) await readExactly(socket, 4, timeoutMs, deadlineAt);
  else if (addressType === 4) {
    await readExactly(socket, 16, timeoutMs, deadlineAt);
  } else if (addressType === 3) {
    const length =
      (await readExactly(socket, 1, timeoutMs, deadlineAt))[0] ?? 0;
    await readExactly(socket, length, timeoutMs, deadlineAt);
  } else {
    throw new SocksNegotiationError();
  }
  await readExactly(socket, 2, timeoutMs, deadlineAt);
}

export class SocksConnectAdapter {
  private readonly route: ProxyDefinition;
  private readonly connectTimeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly sockets = new Set<Socket>();
  private server: http.Server | null = null;
  private startPromise: Promise<string> | null = null;
  private closed = false;

  constructor(route: ProxyDefinition, opts: SocksConnectAdapterOpts = {}) {
    if (route.scheme !== "socks4" && route.scheme !== "socks5") {
      throw new Error("SOCKS adapter requires a SOCKS route");
    }
    this.route = route;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  }

  start(): Promise<string> {
    if (this.closed)
      return Promise.reject(new Error("SOCKS adapter is closed"));
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startInner();
    return this.startPromise;
  }

  private async startInner(): Promise<string> {
    const server = http.createServer((_req, res) => {
      res.writeHead(405, { connection: "close" });
      res.end();
    });
    server.headersTimeout = this.connectTimeoutMs;
    server.requestTimeout = this.connectTimeoutMs;
    server.on("connection", (socket) => this.track(socket));
    server.on("connect", (req, socket, head) => {
      void this.handleConnect(req, socket as Socket, head).catch(() => {
        const client = socket as Socket;
        if (!client.destroyed) {
          client.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
        }
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(0, "127.0.0.1");
    });
    if (this.closed) {
      await this.closeServer(server);
      throw new Error("SOCKS adapter is closed");
    }
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("SOCKS adapter has no TCP address");
    }
    return `http://127.0.0.1:${address.port}`;
  }

  private track(socket: Socket): void {
    this.sockets.add(socket);
    socket.once("close", () => this.sockets.delete(socket));
  }

  private async handleConnect(
    _req: http.IncomingMessage,
    client: Socket,
    head: Buffer,
  ): Promise<void> {
    if (this.closed) throw new Error("SOCKS adapter is closed");
    const target = parseAuthority(_req.url ?? "");
    const upstream = await connectSocket(
      this.route.host,
      this.route.port,
      this.connectTimeoutMs,
    );
    this.track(upstream);
    const closeUpstream = () => upstream.destroy();
    client.once("close", closeUpstream);
    try {
      if (this.route.scheme === "socks4") {
        await negotiateSocks4(upstream, target, this.connectTimeoutMs);
      } else {
        await negotiateSocks5(upstream, target, this.connectTimeoutMs);
      }
      if (this.closed || client.destroyed) throw new Error("client closed");
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.byteLength > 0) upstream.write(head);
      client.setTimeout(this.idleTimeoutMs, () => client.destroy());
      upstream.setTimeout(this.idleTimeoutMs, () => upstream.destroy());
      upstream.once("close", () => client.destroy());
      client.pipe(upstream);
      upstream.pipe(client);
    } catch (error) {
      upstream.destroy();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    const server = this.server;
    this.server = null;
    if (server) await this.closeServer(server);
  }

  private closeServer(server: http.Server): Promise<void> {
    if (!server.listening) return Promise.resolve();
    return new Promise((resolve) => server.close(() => resolve()));
  }
}
