import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export const SERVER_VERSION = "1.6.0";
export const DEFAULT_MODEL = "moonshotai/kimi-k3";
export const UPSTREAM_BASE = "https://api.ngc.nvidia.com/v2/predict";
export const NAMESPACE = "qc69jvmznzxy"; // predict/queue deployment namespace
export const ORIGIN = "https://build.nvidia.com";
export const REFERER = "https://build.nvidia.com/";
export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const num = (v: string | undefined, dflt: number): number => {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

const lightpandaExe =
  process.platform === "win32" ? "lightpanda.exe" : "lightpanda";

export function detectLightpanda(): string {
  const override = process.env.LIGHTPANDA_PATH;
  if (override) {
    if (!existsSync(override)) {
      throw new Error(`LIGHTPANDA_PATH does not exist: ${override}`);
    }
    return override;
  }
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, lightpandaExe);
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `lightpanda not found on PATH; set LIGHTPANDA_PATH to the binary location`,
  );
}

export function parseKeys(rawValue: string): string[] {
  return rawValue
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

export const env = {
  port: num(process.env.PORT, 8787),
  poolSize: Math.max(1, Math.trunc(num(process.env.POOL_SIZE, 1))),
  model: process.env.MODEL ?? DEFAULT_MODEL,
  host: process.env.HOST ?? "127.0.0.1",
  apiKeys: parseKeys(process.env.API_KEY ?? ""),
  proxyFile: process.env.PROXY_FILE ?? "PROXIES.txt",
  upstreamConcurrency: Math.max(
    1,
    Math.trunc(num(process.env.UPSTREAM_CONCURRENCY, 1)),
  ),
  upstreamMinIntervalMs: Math.max(
    0,
    num(process.env.UPSTREAM_MIN_INTERVAL_MS, 15_000),
  ),
  upstreamBackoffMs: Math.max(0, num(process.env.UPSTREAM_BACKOFF_MS, 120_000)),
  upstreamMaxBackoffMs: Math.max(
    0,
    num(process.env.UPSTREAM_MAX_BACKOFF_MS, 600_000),
  ),
  upstreamHeadersTimeoutMs: Math.max(
    1_000,
    num(process.env.UPSTREAM_HEADERS_TIMEOUT_MS, 120_000),
  ),
  upstreamBodyTimeoutMs: Math.max(
    1_000,
    num(process.env.UPSTREAM_BODY_TIMEOUT_MS, 120_000),
  ),
  upstreamStreamIdleTimeoutMs: Math.max(
    1_000,
    num(process.env.UPSTREAM_STREAM_IDLE_TIMEOUT_MS, 120_000),
  ),
};
