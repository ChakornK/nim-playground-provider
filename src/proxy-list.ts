import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { BlockList, isIP } from "node:net";

export const MAX_PROXY_FILE_BYTES = 1024 * 1024;
export const MAX_PROXY_FILE_LINES = 10_000;

export type ProxyScheme = "http" | "socks4" | "socks5";

export type ProxyLineReason =
  | "invalid_syntax"
  | "unsupported_scheme"
  | "credentials_not_allowed"
  | "hostname_not_allowed"
  | "non_global_address"
  | "invalid_port"
  | "path_not_allowed"
  | "query_not_allowed"
  | "fragment_not_allowed";

export interface ProxyDefinition {
  id: string;
  scheme: ProxyScheme;
  host: string;
  port: number;
  canonicalUrl: string;
}

export interface ProxyLineDiagnostic {
  line: number;
  reason: ProxyLineReason;
}

export interface ProxyListResult {
  routes: ProxyDefinition[];
  rejectedLines: ProxyLineDiagnostic[];
}

export type ProxyFileState = "missing" | "loaded" | "unusable";

export interface ProxyFileLoadResult extends ProxyListResult {
  path: string;
  state: ProxyFileState;
  errorCategory?:
    | "unreadable"
    | "too_large"
    | "too_many_lines"
    | "invalid_utf8";
}

const NON_GLOBAL_IPV6 = [
  ["::", 128],
  ["::1", 128],
  ["::ffff:0:0", 96],
  ["64:ff9b::", 96],
  ["100::", 64],
  ["2001::", 32],
  ["2001:2::", 48],
  ["2001:10::", 28],
  ["2001:20::", 28],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const;

const ipv6BlockList = new BlockList();
for (const [network, prefix] of NON_GLOBAL_IPV6) {
  ipv6BlockList.addSubnet(network, prefix, "ipv6");
}

const ipv4Number = (host: string): number => {
  const octets = host.split(".").map(Number);
  return (
    (((octets[0] ?? 0) << 24) >>> 0) +
    ((octets[1] ?? 0) << 16) +
    ((octets[2] ?? 0) << 8) +
    (octets[3] ?? 0)
  );
};

const inIpv4Cidr = (
  value: number,
  network: string,
  prefix: number,
): boolean => {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (value & mask) === (ipv4Number(network) & mask);
};

const isGlobalIpv4 = (host: string): boolean => {
  const value = ipv4Number(host);
  if (host === "192.0.0.9" || host === "192.0.0.10") return true;
  const blocked = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.88.99.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4],
    ["240.0.0.0", 4],
  ] as const;
  return !blocked.some(([network, prefix]) =>
    inIpv4Cidr(value, network, prefix),
  );
};

export function isGlobalProxyAddress(host: string): boolean {
  const family = isIP(host);
  if (family === 4) return isGlobalIpv4(host);
  if (family !== 6) return false;
  return !ipv6BlockList.check(host, "ipv6");
}

const lineCount = (text: string): number => {
  if (text.length === 0) return 0;
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.at(-1) === "") lines.pop();
  return lines.length;
};

const diagnostic = (
  line: number,
  reason: ProxyLineReason,
): { diagnostic: ProxyLineDiagnostic } => ({ diagnostic: { line, reason } });

function parseProxyLine(
  raw: string,
  line: number,
): { route: ProxyDefinition } | { diagnostic: ProxyLineDiagnostic } | null {
  const value = raw.trim();
  if (!value || value.startsWith("#")) return null;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value);
  if (!schemeMatch) return diagnostic(line, "invalid_syntax");
  const scheme = schemeMatch[1]?.toLowerCase();
  if (scheme !== "http" && scheme !== "socks4" && scheme !== "socks5") {
    return diagnostic(line, "unsupported_scheme");
  }
  if (value.includes("@")) return diagnostic(line, "credentials_not_allowed");
  if (value.includes("?")) return diagnostic(line, "query_not_allowed");
  if (value.includes("#")) return diagnostic(line, "fragment_not_allowed");

  const match =
    /^(?:http|socks4|socks5):\/\/(\[[^\]]+\]|[^:/?#]+):(\d+)$/i.exec(value);
  if (!match) {
    const authority = value.slice((schemeMatch[0] ?? "").length);
    if (authority.includes("/")) return diagnostic(line, "path_not_allowed");
    return diagnostic(line, "invalid_syntax");
  }

  const rawHost = match[1] ?? "";
  const host = rawHost.startsWith("[") ? rawHost.slice(1, -1) : rawHost;
  const family = isIP(host);
  if (family === 0) return diagnostic(line, "hostname_not_allowed");
  if (!isGlobalProxyAddress(host)) {
    return diagnostic(line, "non_global_address");
  }

  const port = Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return diagnostic(line, "invalid_port");
  }

  let normalizedHost = host;
  if (family === 6) {
    normalizedHost = new URL(`http://[${host}]:1`).hostname.slice(1, -1);
  }
  const authorityHost = family === 6 ? `[${normalizedHost}]` : normalizedHost;
  const canonicalUrl = `${scheme}://${authorityHost}:${port}`;
  const id = createHash("sha256").update(canonicalUrl).digest("hex");
  return {
    route: { id, scheme, host: normalizedHost, port, canonicalUrl },
  };
}

export function parseProxyList(text: string): ProxyListResult {
  if (Buffer.byteLength(text, "utf8") > MAX_PROXY_FILE_BYTES) {
    throw new RangeError("proxy file exceeds byte limit");
  }
  if (lineCount(text) > MAX_PROXY_FILE_LINES) {
    throw new RangeError("proxy file exceeds line limit");
  }

  const routes: ProxyDefinition[] = [];
  const rejectedLines: ProxyLineDiagnostic[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r\n|\n|\r/);
  for (const [index, raw] of lines.entries()) {
    const parsed = parseProxyLine(raw, index + 1);
    if (!parsed) continue;
    if ("diagnostic" in parsed) {
      rejectedLines.push(parsed.diagnostic);
      continue;
    }
    if (seen.has(parsed.route.canonicalUrl)) continue;
    seen.add(parsed.route.canonicalUrl);
    routes.push(parsed.route);
  }
  return { routes, rejectedLines };
}

export function formatProxyList(routes: readonly ProxyDefinition[]): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const route of routes) {
    if (seen.has(route.canonicalUrl)) continue;
    seen.add(route.canonicalUrl);
    lines.push(route.canonicalUrl);
  }
  return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

export function assertProxyModeConcurrency(
  proxyFile: ProxyFileLoadResult,
  concurrency: number,
): void {
  if (proxyFile.state === "loaded" && concurrency !== 1) {
    throw new Error(
      "UPSTREAM_CONCURRENCY must be 1 when PROXIES.txt contains valid routes",
    );
  }
}

export async function loadProxyFile(
  path: string,
): Promise<ProxyFileLoadResult> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { path, state: "missing", routes: [], rejectedLines: [] };
    }
    return {
      path,
      state: "unusable",
      routes: [],
      rejectedLines: [],
      errorCategory: "unreadable",
    };
  }

  if (bytes.byteLength > MAX_PROXY_FILE_BYTES) {
    return {
      path,
      state: "unusable",
      routes: [],
      rejectedLines: [],
      errorCategory: "too_large",
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      path,
      state: "unusable",
      routes: [],
      rejectedLines: [],
      errorCategory: "invalid_utf8",
    };
  }
  if (lineCount(text) > MAX_PROXY_FILE_LINES) {
    return {
      path,
      state: "unusable",
      routes: [],
      rejectedLines: [],
      errorCategory: "too_many_lines",
    };
  }

  const parsed = parseProxyList(text);
  return {
    path,
    state: parsed.routes.length > 0 ? "loaded" : "unusable",
    ...parsed,
  };
}
