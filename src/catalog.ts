// Catalog of NVIDIA NIM models that this proxy can serve. Built at startup
// from the public OpenAI-compatible model list (`integrate.api.nvidia.com`)
// plus per-model function IDs from the queue endpoint.

import { UPSTREAM_BASE } from "./constants";

export interface CatalogEntry {
  /** OpenAI-compatible model, e.g. `z-ai/glm-5.2`. Also the body `model`. */
  id: string;
  /** Predict path segment, e.g. `glm-5.2` or `llama-3_1-8b-instruct`. */
  slug: string;
  /** Per-model value for the `nv-function-id` header. */
  functionId: string;
  created: number;
  ownedBy: string;
}

export const INTEGRATE_MODELS_URL =
  "https://integrate.api.nvidia.com/v1/models";
const NAMESPACE = "qc69jvmznzxy";

type CatalogFetch = (
  url: string | URL,
  init?: { headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<Response>;

const queueUrl = (slug: string) =>
  `${UPSTREAM_BASE}/queues/models/${NAMESPACE}/${slug}`;

const UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const QUEUE_HEADERS = {
  "user-agent": UA,
  origin: "https://build.nvidia.com",
  referer: "https://build.nvidia.com/",
};

/**
 * Models that are not usable through chat completions: embeddings, rerankers,
 * document parsers, speech, image/video generation, score/reward or
 * guard/safety classifiers, or scientific models. Everything else outputs
 * text and is chat-capable (multimodal vision-language models are kept).
 */
export function isTextCapable(id: string): boolean {
  const name = id.toLowerCase();
  if (
    /(^|\/)(bge|metadata|milvus|nvclip|cosmos-transfer|cosmos3|flux|sdxl|controlnet|img2img|kandinsky|stable-diffusion|whisper|parakeet|conformer|canary|riva|speaker|lipsync|eyecontact|asr|tts|text-to-speech|speech|voicegen|molt|fidelity|fluent|fourcastnet|cuopt|alphafold|esm[0-9]?|esmfold|diffdock|boltz|openfold|evo2|genmol|diffusion-test|molecular)/.test(
      name,
    )
  )
    return false;
  // Embedding/retrieval/score/guard outputs are not chat text.
  if (
    /(embed|retriev|rerank|parse|ocr|reward|guard|content-safety|topic-control|safety|nis-email|dns|evil|calc|mitre|vuln|divergentca|cve)/.test(
      name,
    )
  )
    return false;
  return true;
}

/** Predict-path candidates for an OpenAI id: the bare name, then dots→underscores. */
export function slugCandidates(id: string): string[] {
  const name = id.split("/", 2)[1] ?? id;
  return [name, name.replaceAll(".", "_")];
}

async function probeFunctionId(
  slug: string,
  fetchImpl: CatalogFetch,
): Promise<string | null> {
  try {
    const r = await fetchImpl(queueUrl(slug), {
      headers: QUEUE_HEADERS,
      signal: AbortSignal.timeout(15_000),
    });
    if (!r.ok) return null;
    const body = (await r.json()) as { functionId?: string };
    if (typeof body.functionId !== "string") return null;
    return body.functionId;
  } catch {
    return null;
  }
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      const item = items[i];
      if (i >= items.length || item === undefined) return;
      out[i] = await fn(item);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return out;
}

/**
 * Fetch the servable catalog. Throws if the integrate list itself is
 * unreachable; individual queue probes that fail are skipped silently.
 */
export async function buildCatalog(opts?: {
  fetchImpl?: CatalogFetch;
  concurrency?: number;
}): Promise<CatalogEntry[]> {
  const fetchImpl: CatalogFetch = opts?.fetchImpl ?? fetch;
  const r = await fetchImpl(INTEGRATE_MODELS_URL, {
    headers: { "user-agent": UA },
  });
  if (!r.ok) throw new Error(`integrate model list ${r.status}`);
  const list = (await r.json()) as {
    data: Array<{ id: string; created: number; owned_by: string }>;
  };
  if (!Array.isArray(list.data))
    throw new Error("integrate model list malformed");

  const entries = await mapPool(
    list.data,
    opts?.concurrency ?? 12,
    async (m) => {
      for (const slug of slugCandidates(m.id)) {
        const functionId = await probeFunctionId(slug, fetchImpl);
        if (functionId)
          return {
            id: m.id,
            slug,
            functionId,
            created: typeof m.created === "number" ? m.created : 0,
            ownedBy: m.owned_by,
          };
      }
      return null;
    },
  );

  return entries
    .filter((e): e is CatalogEntry => e !== null && isTextCapable(e.id))
    .sort((a, b) => a.id.localeCompare(b.id));
}
