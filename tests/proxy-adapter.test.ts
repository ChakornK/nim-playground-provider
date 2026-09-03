import { expect, test } from "bun:test";
import net, { type Server, type Socket } from "node:net";
import { SocksConnectAdapter } from "../src/proxy-adapter.ts";
import type { ProxyDefinition, ProxyScheme } from "../src/proxy-list.ts";

const deadline = <T>(promise: Promise<T>, ms = 2_000): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(() => reject(new Error("test timed out")), ms),
    ),
  ]);

const listen = (server: Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("missing server address"));
        return;
      }
      resolve(address.port);
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => server.close(() => resolve()));

async function readAtLeast(socket: Socket, size: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total < size) {
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      socket.once("data", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("socket closed")));
    });
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  const combined = Buffer.concat(chunks);
  if (combined.byteLength > size) socket.unshift(combined.subarray(size));
  return combined.subarray(0, size);
}

async function readUntil(socket: Socket, marker: Buffer): Promise<Buffer> {
  let data = Buffer.alloc(0);
  while (data.indexOf(marker) === -1) {
    const chunk = await new Promise<Buffer>((resolve, reject) => {
      socket.once("data", resolve);
      socket.once("error", reject);
      socket.once("close", () => reject(new Error("socket closed")));
    });
    data = Buffer.concat([data, chunk]);
  }
  const end = data.indexOf(marker) + marker.byteLength;
  if (data.byteLength > end) socket.unshift(data.subarray(end));
  return data.subarray(0, end);
}

const definition = (scheme: ProxyScheme, port: number): ProxyDefinition => ({
  id: `${scheme}-test`,
  scheme,
  host: "127.0.0.1",
  port,
  canonicalUrl: `${scheme}://127.0.0.1:${port}`,
});

const connectThroughAdapter = async (
  adapterUrl: string,
  authority: string,
): Promise<Socket> => {
  const adapterPort = Number(new URL(adapterUrl).port);
  const client = net.createConnection({ host: "127.0.0.1", port: adapterPort });
  await new Promise<void>((resolve, reject) => {
    client.once("connect", resolve);
    client.once("error", reject);
  });
  client.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`);
  const response = await readUntil(client, Buffer.from("\r\n\r\n"));
  expect(response.toString()).toStartWith("HTTP/1.1 200");
  return client;
};

test("SOCKS5 adapter performs no-auth domain CONNECT and relays bytes", async () => {
  let target: { host: string; port: number } | undefined;
  const socks = net.createServer((socket) => {
    void (async () => {
      expect(await readAtLeast(socket, 3)).toEqual(Buffer.from([5, 1, 0]));
      socket.write(Buffer.from([5, 0]));
      const header = await readAtLeast(socket, 5);
      expect(header.subarray(0, 4)).toEqual(Buffer.from([5, 1, 0, 3]));
      const length = header[4] ?? 0;
      const domain = await readAtLeast(socket, length);
      const portBytes = await readAtLeast(socket, 2);
      target = { host: domain.toString(), port: portBytes.readUInt16BE() };
      socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
      socket.on("data", (chunk) => socket.write(chunk));
    })().catch(() => socket.destroy());
  });
  const socksPort = await listen(socks);
  const adapter = new SocksConnectAdapter(definition("socks5", socksPort), {
    connectTimeoutMs: 500,
    idleTimeoutMs: 1_000,
  });
  try {
    const adapterUrl = await adapter.start();
    const client = await deadline(
      connectThroughAdapter(adapterUrl, "api.ngc.nvidia.com:443"),
    );
    expect(target).toEqual({ host: "api.ngc.nvidia.com", port: 443 });
    client.write("ping");
    expect((await deadline(readAtLeast(client, 4))).toString()).toBe("ping");
    client.destroy();
  } finally {
    await adapter.close();
    await closeServer(socks);
  }
});

test("SOCKS4 adapter performs SOCKS4a domain CONNECT", async () => {
  let request = Buffer.alloc(0);
  const socks = net.createServer((socket) => {
    socket.once("data", (chunk) => {
      request = Buffer.from(chunk);
      socket.write(Buffer.from([0, 0x5a, 0, 0, 0, 0, 0, 0]));
    });
  });
  const socksPort = await listen(socks);
  const adapter = new SocksConnectAdapter(definition("socks4", socksPort), {
    connectTimeoutMs: 500,
  });
  try {
    const client = await deadline(
      connectThroughAdapter(await adapter.start(), "api.hcaptcha.com:443"),
    );
    expect(request.subarray(0, 2)).toEqual(Buffer.from([4, 1]));
    expect(request.readUInt16BE(2)).toBe(443);
    expect(request.subarray(4, 8)).toEqual(Buffer.from([0, 0, 0, 1]));
    expect(request.subarray(9, -1).toString()).toBe("api.hcaptcha.com");
    client.destroy();
  } finally {
    await adapter.close();
    await closeServer(socks);
  }
});

test("adapter rejects ordinary HTTP and closes its listener idempotently", async () => {
  const socks = net.createServer();
  const socksPort = await listen(socks);
  const adapter = new SocksConnectAdapter(definition("socks5", socksPort));
  const adapterUrl = await adapter.start();
  expect((await fetch(adapterUrl)).status).toBe(405);
  await adapter.close();
  await adapter.close();

  const port = Number(new URL(adapterUrl).port);
  await expect(
    deadline(
      new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.once("connect", resolve);
        socket.once("error", reject);
      }),
    ),
  ).rejects.toBeDefined();
  await closeServer(socks);
});

test("adapter bounds a stalled SOCKS negotiation", async () => {
  let socksClient: Socket | undefined;
  const socks = net.createServer((socket) => {
    socksClient = socket;
  });
  const socksPort = await listen(socks);
  const adapter = new SocksConnectAdapter(definition("socks5", socksPort), {
    connectTimeoutMs: 30,
  });
  try {
    const adapterPort = Number(new URL(await adapter.start()).port);
    const client = net.createConnection({
      host: "127.0.0.1",
      port: adapterPort,
    });
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    client.write(
      "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
    );
    const response = await deadline(readUntil(client, Buffer.from("\r\n\r\n")));
    expect(response.toString()).toStartWith("HTTP/1.1 502");
    client.destroy();
  } finally {
    await adapter.close();
    socksClient?.destroy();
    await closeServer(socks);
  }
});

test("adapter returns 502 when SOCKS negotiation fails", async () => {
  const socks = net.createServer((socket) => {
    socket.once("data", () => socket.end(Buffer.from([5, 0xff])));
  });
  const socksPort = await listen(socks);
  const adapter = new SocksConnectAdapter(definition("socks5", socksPort), {
    connectTimeoutMs: 500,
  });
  try {
    const adapterPort = Number(new URL(await adapter.start()).port);
    const client = net.createConnection({
      host: "127.0.0.1",
      port: adapterPort,
    });
    await new Promise<void>((resolve, reject) => {
      client.once("connect", resolve);
      client.once("error", reject);
    });
    client.write(
      "CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n",
    );
    const response = await deadline(readUntil(client, Buffer.from("\r\n\r\n")));
    expect(response.toString()).toStartWith("HTTP/1.1 502");
    client.destroy();
  } finally {
    await adapter.close();
    await closeServer(socks);
  }
});
