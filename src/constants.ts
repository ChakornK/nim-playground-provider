import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";

export const DEFAULT_MODEL = "minimaxai/minimax-m3";
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
  if (override) return override;
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
  poolSize: Math.max(1, Math.trunc(num(process.env.POOL_SIZE, 2))),
  lightpandaPath: process.env.LIGHTPANDA_PATH,
  model: process.env.MODEL ?? DEFAULT_MODEL,
  host: process.env.HOST ?? "127.0.0.1",
  apiKeys: parseKeys(process.env.API_KEY ?? ""),
};
