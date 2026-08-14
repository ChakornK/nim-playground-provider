export const DEFAULT_MODEL = "z-ai/glm-5.2";
export const UPSTREAM_BASE = "https://api.ngc.nvidia.com/v2/predict";
export const NAMESPACE = "qc69jvmznzxy"; // predict/queue deployment namespace
export const ORIGIN = "https://build.nvidia.com";
export const REFERER = "https://build.nvidia.com/";
export const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const num = (v: string | undefined, dflt: number): number => {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

export const env = {
  port: num(process.env.PORT, 8787),
  poolSize: Math.max(1, Math.trunc(num(process.env.POOL_SIZE, 2))),
  chromiumPath: process.env.CHROMIUM_PATH,
  model: process.env.MODEL ?? DEFAULT_MODEL,
  host: process.env.HOST ?? "127.0.0.1",
};
