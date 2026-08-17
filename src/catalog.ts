// Catalog of NVIDIA NIM models that this proxy can serve. The candidate ids
// come from the public OpenAI-compatible model list (`integrate.api.nvidia.com`);
// per model, the deploy namespace, function id and modalities are read from the
// model page HTML on build.nvidia.com. A model is served iff its page reports
// Text among both input and output modalities. The page's `nvcfFunctionId` is
// the per-model value used as the `nv-function-id` request header, so no queue
// probe is needed.

import { USER_AGENT } from "./constants.ts";
import type { CatalogEntry, ModelRoute } from "./types.ts";

export type { CatalogEntry, ModelRoute };

export const INTEGRATE_MODELS_URL =
  "https://integrate.api.nvidia.com/v1/models";
const PAGE_ORIGIN = "https://build.nvidia.com";

type CatalogFetch = (
  url: string | URL,
  init?: {
    headers?: Record<string, string>;
    redirect?: RequestRedirect;
    signal?: AbortSignal;
  },
) => Promise<Response>;

interface PageData {
  namespace: string;
  functionId: string;
  inputModalities: string[];
  outputModalities: string[];
}

// The page embeds the deployment blob as a JSON string (quotes backslash-escaped)
// inside a larger JSON; all four fields use the same escape shape as the prior
// namespace regex.
const NS_RE = /\\"namespace\\":\\"([^"\\]+)\\"/;
const NVCF_RE = /\\"nvcfFunctionId\\":\\"([^"\\]+)\\"/;
const INPUT_RE = /\\"inputModalities\\":\[(.*?)\]/;
const OUTPUT_RE = /\\"outputModalities\\":\[(.*?)\]/;
const TOKEN_RE = /\\"([A-Za-z]+)\\"/g;

const PAGE_HEADERS = { "user-agent": USER_AGENT };

function pageUrl(id: string, slug: string): string {
  const org = id.split("/")[0] ?? id;
  return `${PAGE_ORIGIN}/${org}/${slug}`;
}

function parseEscapedArray(slice: string | undefined): string[] {
  if (!slice) return [];
  return Array.from(slice.matchAll(TOKEN_RE), (m) => m[1] ?? "").filter(
    Boolean,
  );
}

function parsePage(html: string): PageData | null {
  const namespace = html.match(NS_RE)?.[1];
  const functionId = html.match(NVCF_RE)?.[1];
  // NVIDIA serializes an undeployed model as `nvcfFunctionId: "None"` -> not servable.
  if (!namespace || !functionId || functionId === "None") return null;
  return {
    namespace,
    functionId,
    inputModalities: parseEscapedArray(html.match(INPUT_RE)?.[1]),
    outputModalities: parseEscapedArray(html.match(OUTPUT_RE)?.[1]),
  };
}

/** Predict-path candidates for an OpenAI id: the bare name, then dots→underscores. */
export function slugCandidates(id: string): string[] {
  const name = id.split("/", 2)[1] ?? id;
  const underscored = name.replaceAll(".", "_");
  return name === underscored ? [name] : [name, underscored];
}

async function fetchModelPage(
  id: string,
  slug: string,
  fetchImpl: CatalogFetch,
): Promise<PageData | null> {
  try {
    // redirect: "error" skips stale integrate ids whose page 308-renames to a
    // different model (e.g. nvidia/cosmos-reason2-8b → cosmos3-nano-reasoner);
    // following would mis-attribute the renamed model's route back to the old id.
    const r = await fetchImpl(pageUrl(id, slug), {
      headers: PAGE_HEADERS,
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    return parsePage(await r.text());
  } catch {
    return null;
  }
}

/** Include iff the page reports Text among input AND output modalities. */
function isTextInTextOut(page: PageData): boolean {
  return (
    page.inputModalities.includes("Text") &&
    page.outputModalities.includes("Text")
  );
}

/**
 * Resolve a single model's deploy route from its build.nvidia.com page:
 * `modelId` = `{namespace}/{winning slug}`, function id = page `nvcfFunctionId`.
 * Returns null when no candidate slug is a real model page.
 */
export async function resolveModelRoute(
  id: string,
  fetchImpl: CatalogFetch = fetch,
): Promise<ModelRoute | null> {
  for (const slug of slugCandidates(id)) {
    const page = await fetchModelPage(id, slug, fetchImpl);
    if (page)
      return {
        modelId: `${page.namespace}/${slug}`,
        functionId: page.functionId,
      };
  }
  return null;
}

// Fallback catalog refresh interval when the response has no Cache-Control.
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;

export interface CatalogResult {
  entries: CatalogEntry[];
  refreshMs: number;
}

function parseMaxAge(cc: string | null): number | null {
  if (!cc) return null;
  const m = cc.match(/max-age=(\d+)/i);
  return m?.[1] ? parseInt(m[1], 10) * 1000 : null;
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
 * Fetch the servable catalog. Throws if the integrate model list itself is
 * unreachable. Per model, the build.nvidia.com page is read for the function
 * id, namespace and modalities; only Text-in/Text-out models with a real model
 * page are kept — older-template pages that lack the modalities field, stale
 * renamed ids, and ids without a page are dropped.
 */
export async function buildCatalog(opts?: {
  fetchImpl?: CatalogFetch;
  concurrency?: number;
  onProgress?: (fetched: number, total: number) => void;
}): Promise<CatalogResult> {
  const fetchImpl: CatalogFetch = opts?.fetchImpl ?? fetch;
  const r = await fetchImpl(INTEGRATE_MODELS_URL, {
    headers: { "user-agent": USER_AGENT },
  });
  if (!r.ok) throw new Error(`integrate model list ${r.status}`);
  const refreshMs =
    parseMaxAge(r.headers.get("cache-control")) ?? DEFAULT_REFRESH_MS;
  const list = (await r.json()) as {
    data: Array<{ id: string; created: number; owned_by: string }>;
  };
  if (!Array.isArray(list.data))
    throw new Error("integrate model list malformed");

  const onProgress = opts?.onProgress;
  onProgress?.(0, list.data.length);

  let done = 0;
  const entries = await mapPool(
    list.data,
    opts?.concurrency ?? 4,
    async (m) => {
      try {
        for (const slug of slugCandidates(m.id)) {
          const page = await fetchModelPage(m.id, slug, fetchImpl);
          if (!page) continue;
          if (!isTextInTextOut(page)) return null;
          return {
            id: m.id,
            slug,
            namespace: page.namespace,
            functionId: page.functionId,
            created: typeof m.created === "number" ? m.created : 0,
            ownedBy: m.owned_by,
          } as CatalogEntry;
        }
        return null;
      } finally {
        onProgress?.(++done, list.data.length);
      }
    },
  );

  const sorted = entries
    .filter((e): e is CatalogEntry => e !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { entries: sorted, refreshMs };
}
