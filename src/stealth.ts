import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tls from "node:tls";
import { promisify } from "node:util";
import { USER_AGENT } from "./constants.ts";

const execFileAsync = promisify(execFile);

/** Wire identity every outgoing request is rewritten to match. */
const WIRE_USER_AGENT = USER_AGENT;

const SEC_CH_UA =
  '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"';

const HEADER_OVERRIDES: Record<string, string> = {
  "user-agent": WIRE_USER_AGENT,
  "sec-ch-ua": SEC_CH_UA,
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Linux"',
  "accept-language": "en-US,en;q=0.9",
  // Chrome 124 wire order; lightpanda emits "deflate, gzip, br".
  "accept-encoding": "gzip, deflate, br, zstd",
};

/** Headers that leak the proxy/client layer and must never be forwarded. */
const STRIP_HEADERS = new Set([
  "proxy-authorization",
  "proxy-connection",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const CA_LIFETIME_DAYS = "3650";
const CERT_LIFETIME_DAYS = "825";

interface CertPair {
  key: string;
  cert: string;
}

/**
 * TLS-terminating forward proxy. lightpanda refuses to send a real Chrome UA
 * on the wire (its --user-agent flag forbids "Mozilla" and it always injects
 * `sec-ch-ua: "Lightpanda";v="1"` after Fetch interception), so we MITM its
 * traffic and rewrite request headers to a commercial Chrome shape.
 */
export class StealthProxy {
  private dir: string;
  private caCertPath: string;
  private caKeyPath: string;
  private certs = new Map<string, Promise<CertPair>>();
  private server: net.Server | null = null;
  // http.Server requests are fed CONNECted TLS sockets.
  private inner: http.Server;

  constructor(dir?: string) {
    this.dir =
      dir ??
      join(
        tmpdir(),
        `stealth-${createHash("sha1").update(String(process.pid)).digest("hex").slice(0, 8)}`,
      );
    this.caCertPath = join(this.dir, "ca.crt");
    this.caKeyPath = join(this.dir, "ca.key");
    this.inner = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
    });
  }

  /** Start the proxy, generating the CA if needed. Returns the proxy URL and
   * the CA cert path to hand to lightpanda's --http-proxy/--ca-cert. */
  async start(): Promise<{ proxyUrl: string; caCertPath: string }> {
    mkdirSync(this.dir, { recursive: true });
    if (!existsSync(this.caCertPath) || !existsSync(this.caKeyPath)) {
      await execFileAsync("openssl", [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-keyout",
        this.caKeyPath,
        "-out",
        this.caCertPath,
        "-days",
        CA_LIFETIME_DAYS,
        "-nodes",
        "-subj",
        "/CN=nim-stealth-proxy",
      ]);
      // CA key readable by the in-process TLS wrapper only.
    }
    this.server = net.createServer((socket) =>
      this.inner.emit("connection", socket),
    );
    this.inner.on(
      "connect",
      (req, socket, head) =>
        void this.handleConnect(req, socket as net.Socket, head).catch(() =>
          (socket as net.Socket).destroy(),
        ),
    );
    await new Promise<void>((resolve, reject) => {
      (this.server as net.Server).once("error", reject);
      (this.server as net.Server).listen(0, "127.0.0.1", () => resolve());
    });
    const addr = this.server?.address() as { port: number };
    return {
      proxyUrl: `http://127.0.0.1:${addr.port}`,
      caCertPath: this.caCertPath,
    };
  }

  async stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    if (s) await new Promise<void>((r) => s.close(() => r()));
  }

  /** Terminate TLS with a host-matching cert, then run the inner HTTP parser. */
  private async handleConnect(
    req: http.IncomingMessage,
    socket: net.Socket,
    head: Buffer,
  ): Promise<void> {
    const host = (req.url ?? "").split(":")[0] ?? "";
    if (!host) {
      socket.destroy();
      return;
    }
    const { key, cert } = await this.certFor(host);
    socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    const secure = new tls.TLSSocket(socket, {
      isServer: true,
      key,
      cert,
      requestCert: false,
    });
    if (head?.length) secure.unshift(head);
    // Keep both ends honest; without a timeout an idle TLS wrapper pins a
    // lightpanda slot forever.
    secure.setTimeout(120_000, () => secure.destroy());
    this.inner.emit("connection", secure);
  }

  private async certFor(host: string): Promise<CertPair> {
    let p = this.certs.get(host);
    if (!p) {
      p = this.generateCert(host);
      this.certs.set(host, p);
      p.catch(() => this.certs.delete(host));
    }
    return p;
  }

  private async generateCert(host: string): Promise<CertPair> {
    // Slug guards the fs path; SAN content is derived from the raw host.
    const slug = host.replace(/[^a-zA-Z0-9.-]/g, "_");
    const keyPath = join(this.dir, `${slug}.key`);
    const csrPath = join(this.dir, `${slug}.csr`);
    const certPath = join(this.dir, `${slug}.crt`);
    const sanPath = join(this.dir, `${slug}.san.cnf`);
    writeFileSync(sanPath, `subjectAltName=DNS:${host}\n`);
    await execFileAsync("openssl", [
      "req",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      csrPath,
      "-nodes",
      "-subj",
      "/CN=localhost",
    ]);
    await execFileAsync("openssl", [
      "x509",
      "-req",
      "-in",
      csrPath,
      "-CA",
      this.caCertPath,
      "-CAkey",
      this.caKeyPath,
      "-CAcreateserial",
      "-out",
      certPath,
      "-days",
      CERT_LIFETIME_DAYS,
      "-sha256",
      "-extfile",
      sanPath,
    ]);
    return {
      key: readFileSync(keyPath, "utf8"),
      cert: readFileSync(certPath, "utf8"),
    };
  }

  /** Forward one request (plain-http absolute-form, or MITM'd origin-form). */
  private async handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const raw = req.url ?? "/";
    let target: string;
    if (raw.startsWith("http://") || raw.startsWith("https://")) {
      target = raw;
    } else {
      const host = req.headers.host;
      if (!host) {
        res.writeHead(400).end();
        return;
      }
      target = `https://${host}${raw}`;
    }

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (STRIP_HEADERS.has(lk) || !(typeof v === "string")) continue;
      headers[lk] = v;
    }
    const url = new URL(target);
    headers.host = url.host;
    Object.assign(headers, HEADER_OVERRIDES);

    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;

    const upstream = await fetch(target, {
      method: req.method,
      headers,
      body,
      redirect: "manual",
    });

    const out: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (
        k !== "transfer-encoding" &&
        k !== "connection" &&
        k !== "content-length"
      ) {
        out[k] = v;
      }
    });
    if (upstream.body) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      out["content-length"] = String(buf.byteLength);
      res.writeHead(upstream.status, out);
      res.end(buf);
    } else {
      out["content-length"] = "0";
      res.writeHead(upstream.status, out);
      res.end();
    }
  }
}
