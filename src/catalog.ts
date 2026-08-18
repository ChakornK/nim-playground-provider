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

// Page embeds a JSON deployment blob (backslash-escaped) inside a larger JSON.
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
  // NVIDIA marks undeployed models with nvcfFunctionId="None", not servable
  if (!namespace || !functionId || functionId === "None") return null;
  return {
    namespace,
    functionId,
    inputModalities: parseEscapedArray(html.match(INPUT_RE)?.[1]),
    outputModalities: parseEscapedArray(html.match(OUTPUT_RE)?.[1]),
  };
}

/** Predict-path candidates for an OpenAI id, bare name then dots→underscores. */
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
    // redirect=error skips stale ids that 308-rename, else we'd mis-attribute
    // the renamed route to the old id.
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

function isTextInTextOut(page: PageData): boolean {
  return (
    page.inputModalities.includes("Text") &&
    page.outputModalities.includes("Text")
  );
}

/** Resolve a model's deploy route from its build.nvidia.com page.
 * modelId = {namespace}/{winning slug}, functionId = page nvcfFunctionId,
 * null when no candidate slug is a real page. */
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

const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;

export interface CatalogResult {
  entries: CatalogEntry[];
  refreshMs: number;
}

export type CatalogEvent =
  | { type: "gallery-start" }
  | { type: "gallery-done"; count: number }
  | { type: "fallback"; reason: string }
  | { type: "integrate-done"; count: number }
  | { type: "fetch-start"; count: number; concurrency: number }
  | {
      type: "model";
      fetched: number;
      total: number;
      id: string;
      outcome: "kept" | "dropped";
      reason?: string;
    }
  | { type: "fetch-end"; total: number; kept: number; dropped: number };

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

// /models?pageSize=1024 is behind a WAF plain fetch can't solve, lightpanda
// solves it over CDP. DOM embeds each model card as escaped JSON (RSC payload)
// with labels (chat, Free Endpoint), pre-filtering before the per-page fetch.

export interface GalleryCandidate {
  /** Public model id {publisher}/{slug}, same shape as integrate ids. */
  id: string;
  /** Epoch seconds from the gallery dateCreated ISO field. */
  created: number;
  /** Gallery publisher label, the id's org prefix. */
  ownedBy: string;
}

// Needles match the escaped key-value shape inside the RSC string.
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

/** Parse the gallery DOM into free+chat, non-deprecated candidates.
 * Only a passed DEPRECATION date drops a model, `available` is not gated,
 * the per-model page fetch already drops uncallable models. */
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

// Only lightpanda solves the gallery WAF, fall back to integrate when unavailable.
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
    // domcontentloaded fires on the WAF challenge page before the real one
    // renders, poll for the ENDPOINT marker once lightpanda solves the WAF.
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

/** Build the servable catalog. Gallery candidates (free chat) need only a
 * real page (chat label vouches for text in/out), integrate fallback
 * candidates must also report Text modalities and set the refresh interval. */
export async function buildCatalog(opts?: {
  fetchImpl?: CatalogFetch;
  concurrency?: number;
  onEvent?: (e: CatalogEvent) => void;
  lightpandaPath?: string;
  /** Pre-fetched gallery candidates, skips the lightpanda gallery fetch when set. */
  galleryCandidates?: GalleryCandidate[];
}): Promise<CatalogResult> {
  const fetchImpl: CatalogFetch = opts?.fetchImpl ?? fetch;
  const onEvent = opts?.onEvent;

  type Cand = { id: string; created: number; owned_by: string };
  let candidates: Cand[] | null = null;
  let refreshMs = DEFAULT_REFRESH_MS;
  let chatPreFiltered = false;

  if (opts?.galleryCandidates && opts.galleryCandidates.length > 0) {
    candidates = opts.galleryCandidates.map((m) => ({
      id: m.id,
      created: m.created,
      owned_by: m.ownedBy,
    }));
    chatPreFiltered = true;
    onEvent?.({ type: "gallery-done", count: candidates.length });
  } else if (opts?.lightpandaPath) {
    onEvent?.({ type: "gallery-start" });
    try {
      const html = await fetchGalleryHtml(opts.lightpandaPath);
      if (html) {
        const gc = parseGalleryCandidates(html);
        if (gc.length > 0) {
          candidates = gc.map((m) => ({
            id: m.id,
            created: m.created,
            owned_by: m.ownedBy,
          }));
          chatPreFiltered = true;
          onEvent?.({ type: "gallery-done", count: candidates.length });
        }
      }
    } catch {
      candidates = null;
    }
    if (!candidates) onEvent?.({ type: "fallback", reason: "lightpanda/WAF" });
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
    onEvent?.({ type: "integrate-done", count: candidates.length });
  }

  const total = candidates.length;
  const concurrency = opts?.concurrency ?? 4;
  onEvent?.({ type: "fetch-start", count: total, concurrency });

  let done = 0;
  let kept = 0;
  const entries = await mapPool(
    candidates,
    concurrency,
    async (m): Promise<CatalogEntry | null> => {
      const emit = (outcome: "kept" | "dropped", reason?: string) =>
        onEvent?.({
          type: "model",
          fetched: ++done,
          total,
          id: m.id,
          outcome,
          reason,
        });
      for (const slug of slugCandidates(m.id)) {
        const page = await fetchModelPage(m.id, slug, fetchImpl);
        if (!page) continue;
        if (!chatPreFiltered && !isTextInTextOut(page)) {
          emit("dropped", "not text in/out");
          return null;
        }
        kept++;
        emit("kept");
        return {
          id: m.id,
          slug,
          namespace: page.namespace,
          functionId: page.functionId,
          created: typeof m.created === "number" ? m.created : 0,
          ownedBy: m.owned_by,
        } as CatalogEntry;
      }
      emit("dropped", "no deployment page");
      return null;
    },
  );

  onEvent?.({ type: "fetch-end", total, kept, dropped: total - kept });

  const sorted = entries
    .filter((e): e is CatalogEntry => e !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { entries: sorted, refreshMs };
}
