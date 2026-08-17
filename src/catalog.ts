// Catalog of NVIDIA NIM models that this proxy can serve. The candidate ids
// come from the public OpenAI-compatible model list (`integrate.api.nvidia.com`);
// per model, the deploy namespace, function id and modalities are read from the
// model page HTML on build.nvidia.com. A model is served iff its page reports
// Text among both input and output modalities. The page's `nvcfFunctionId` is
// the per-model value used as the `nv-function-id` request header, so no queue
// probe is needed.

import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import { chromium, type Browser } from "playwright-core";
import { USER_AGENT } from "./constants.ts";
import type { CatalogEntry, ModelRoute } from "./types.ts";

export type { CatalogEntry, ModelRoute };

export const INTEGRATE_MODELS_URL =
  "https://integrate.api.nvidia.com/v1/models";
export const GALLERY_URL = "https://build.nvidia.com/models?pageSize=1024";
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

// --- Gallery SSR pre-filter (lightpanda) --------------------------------------
// The gallery at /models?pageSize=1024 is behind an AWS WAF/Akamai challenge
// that plain `fetch` cannot solve (it returns 202/0 bytes). lightpanda's JS
// runs the challenge, so we drive it over CDP to get the rendered DOM, which
// embeds every model card as a backslash-escaped JSON blob in the Next.js RSC
// payload (`self.__next_f.push`). Each blob carries `labels` — including
// `playgroundType:"chat"` and `nimType:"Free Endpoint"` — that let us pick the
// ~32 free chat models up front, instead of fetching all 102 per-model pages.

export interface GalleryCandidate {
  /** Public model id `{publisher}/{slug}` (same shape as integrate ids). */
  id: string;
  /** Epoch seconds, from the gallery `dateCreated` ISO field. */
  created: number;
  /** The gallery `publisher` label (= public org prefix of the id). */
  ownedBy: string;
}

// Needles match the escaped JSON shape `\"k\":\"v\"` inside the RSC string.
const FREE_NEEDLE = '\\"Free Endpoint\\"';
const CHAT_NEEDLE = '\\"playgroundType\\",\\"values\\":[\\"chat\\"';
const DEPREC_RE =
  /\\"key\\":\\"DEPRECATION\\",\\"value\\":\\"(\d{2})\/(\d{2})\/(\d{4})\\"/;

function galleryLabelValue(blob: string, key: string): string {
  const needle = `\\"key\\":\\"${key}\\",\\"values\\":[\\"`;
  const i = blob.indexOf(needle);
  if (i < 0) return "";
  const start = i + needle.length;
  const end = blob.indexOf("\\", start); // closing `\"`
  return end > 0 ? blob.slice(start, end) : "";
}

/**
 * Parse the gallery rendered DOM into the free+chat, non-deprecated model
 * candidates. A model is dropped only when its `DEPRECATION` date has already
 * passed (a future date keeps it servable today, e.g. glm-5.2). `available` is
 * intentionally NOT gated — the per-model page fetch already drops uncallable
 * models, and the gallery's flag lags reality (it drops minimax-m3).
 */
export function parseGalleryCandidates(html: string): GalleryCandidate[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayMs = today.getTime();

  const blobs = html.split('\\"resourceType\\":\\"ENDPOINT\\"');
  const seen = new Map<string, GalleryCandidate>();
  for (let i = 1; i < blobs.length; i++) {
    const b = blobs[i];
    if (!b) continue;
    if (!b.includes(FREE_NEEDLE) || !b.includes(CHAT_NEEDLE)) continue;
    const rid = b.match(/\\"resourceId\\":\\"([^"]*)\\"/)?.[1];
    if (!rid || seen.has(rid)) continue;
    const dep = b.match(DEPREC_RE);
    if (dep) {
      const ms = new Date(
        Number(dep[3]),
        Number(dep[1]) - 1,
        Number(dep[2]),
      ).getTime();
      if (!Number.isNaN(ms) && ms < todayMs) continue;
    }
    const slug = rid.split("/")[1] ?? rid;
    const publisher = galleryLabelValue(b, "publisher");
    if (!publisher) continue;
    const iso = b.match(/\\"dateCreated\\":\\"([^"]*)\\"/)?.[1];
    const ms = iso ? Date.parse(iso) : NaN;
    seen.set(rid, {
      id: `${publisher}/${slug}`,
      created: Number.isNaN(ms) ? 0 : Math.floor(ms / 1000),
      ownedBy: publisher,
    });
  }
  return [...seen.values()];
}

// ponytail: lightpanda is the only client that solves the WAF guarding the
// gallery SSR; if Akamai changes the challenge or lightpanda is missing,
// buildCatalog falls back to integrate (the no-WAF per-model-page path).
async function fetchGalleryHtml(
  lightpandaPath: string,
): Promise<string | null> {
  let proc: ChildProcess | null = null;
  let browser: Browser | null = null;
  try {
    const cdpPort = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const p = (s.address() as AddressInfo).port;
        s.close(() => resolve(p));
      });
    });
    proc = spawn(
      lightpandaPath,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(cdpPort),
        "--log-level",
        "error",
      ],
      { stdio: "ignore" },
    );
    const deadline = Date.now() + 15_000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
      try {
        const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        if (r.ok) ready = true;
      } catch {}
      if (!ready) await new Promise((r) => setTimeout(r, 200));
    }
    if (!ready) return null;
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    const ctx = await browser.newContext({});
    const page = await ctx.newPage();
    await page
      .goto(GALLERY_URL, {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      })
      .catch(() => {});
    // The 202 challenge page resolves domcontentloaded first; the real 200 page
    // (model cards in the RSC payload) renders once lightpanda solves the WAF.
    // Poll page.content() until the ENDPOINT marker appears.
    const marker = '\\"resourceType\\":\\"ENDPOINT\\"';
    for (let i = 0; i < 30; i++) {
      const html = await page.content();
      if (html.includes(marker)) return html;
      await new Promise((r) => setTimeout(r, 500));
    }
    return null;
  } catch {
    return null;
  } finally {
    try {
      await browser?.close();
    } catch {}
    proc?.kill();
  }
}

/**
 * Fetch the servable catalog. Candidate ids come from the build.nvidia.com
 * gallery SSR (via lightpanda, which solves the WAF), pre-filtered to the free
 * chat models that aren't past their deprecation date; per candidate the
 * build.nvidia.com page is read for the function id, namespace and modalities.
 * Only Text-in/Text-out models with a real model page are kept. When lightpanda
 * is unavailable or the gallery fetch yields nothing, falls back to the
 * integrate model list (fetching all per-model pages) — integrate's max-age
 * drives the refresh interval in that case.
 */
export async function buildCatalog(opts?: {
  fetchImpl?: CatalogFetch;
  concurrency?: number;
  onProgress?: (fetched: number, total: number) => void;
  lightpandaPath?: string;
}): Promise<CatalogResult> {
  const fetchImpl: CatalogFetch = opts?.fetchImpl ?? fetch;

  type Cand = { id: string; created: number; owned_by: string };
  let candidates: Cand[] | null = null;
  let refreshMs = DEFAULT_REFRESH_MS;

  if (opts?.lightpandaPath) {
    try {
      const html = await fetchGalleryHtml(opts.lightpandaPath);
      if (html) {
        const gc = parseGalleryCandidates(html);
        if (gc.length > 0)
          candidates = gc.map((m) => ({
            id: m.id,
            created: m.created,
            owned_by: m.ownedBy,
          }));
      }
    } catch {
      candidates = null;
    }
  }

  if (!candidates) {
    const r = await fetchImpl(INTEGRATE_MODELS_URL, {
      headers: { "user-agent": USER_AGENT },
    });
    if (!r.ok) throw new Error(`integrate model list ${r.status}`);
    refreshMs =
      parseMaxAge(r.headers.get("cache-control")) ?? DEFAULT_REFRESH_MS;
    const list = (await r.json()) as {
      data: Array<{ id: string; created: number; owned_by: string }>;
    };
    if (!Array.isArray(list.data))
      throw new Error("integrate model list malformed");
    candidates = list.data;
  }

  const onProgress = opts?.onProgress;
  onProgress?.(0, candidates.length);

  let done = 0;
  const entries = await mapPool(
    candidates,
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
        onProgress?.(++done, candidates.length);
      }
    },
  );

  const sorted = entries
    .filter((e): e is CatalogEntry => e !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { entries: sorted, refreshMs };
}
