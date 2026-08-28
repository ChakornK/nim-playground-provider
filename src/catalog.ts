import { USER_AGENT } from "./constants.ts";
import type { CatalogEntry, ModelRoute } from "./types.ts";

export type { CatalogEntry, ModelRoute };

export const ENDPOINTS_URL =
  "https://api.ngc.nvidia.com/v2/endpoints?page-size=1000";
const ENDPOINTS_BASE = "https://api.ngc.nvidia.com/v2/endpoints";

// undici corrupts zstd bodies, so only offer gzip/br.
const API_HEADERS = {
  "user-agent": USER_AGENT,
  "accept-encoding": "gzip, br",
};

type CatalogFetch = (
  url: string | URL,
  init?: {
    headers?: Record<string, string>;
    redirect?: RequestRedirect;
    signal?: AbortSignal;
  },
) => Promise<Response>;

interface EndpointArtifact {
  name: string;
  orgName: string;
  publisher?: string;
  labels?: string[];
  createdDate?: string;
}

interface EndpointSpec {
  namespace?: string;
  nvcfFunctionId?: string;
  /** Stringified OpenAPI doc describing the accepted request params. */
  openAPISpec?: string;
}

/** Param names the model's chat endpoint accepts, per its OpenAPI spec.
 * Undefined when the spec is missing or unparseable (send everything). */
export function specParams(openAPISpec?: string): string[] | undefined {
  if (!openAPISpec) return undefined;
  try {
    const doc = JSON.parse(openAPISpec) as {
      paths?: Record<
        string,
        {
          post?: {
            requestBody?: {
              content?: { "application/json"?: { schema?: unknown } };
            };
          };
        }
      >;
      components?: {
        schemas?: Record<string, { properties?: Record<string, unknown> }>;
      };
    };
    const path = Object.entries(doc.paths ?? {}).find(([p]) =>
      p.endsWith("/chat/completions"),
    );
    let schema = path?.[1].post?.requestBody?.content?.["application/json"]
      ?.schema as Record<string, unknown> | undefined;
    // ponytail: one $ref hop covers every spec seen so far
    const ref = schema?.$ref;
    if (typeof ref === "string" && ref.startsWith("#/components/schemas/")) {
      schema = doc.components?.schemas?.[ref.split("/").pop() ?? ""] as
        | Record<string, unknown>
        | undefined;
    }
    const props = (
      schema as { properties?: Record<string, unknown> } | undefined
    )?.properties;
    return props ? Object.keys(props) : undefined;
  } catch {
    return undefined;
  }
}

export interface EndpointCandidate {
  /** Public model id {publisher}/{name}. */
  id: string;
  /** Epoch seconds from the artifact createdDate ISO field. */
  created: number;
  ownedBy: string;
  orgName: string;
  name: string;
}

/** Filter the endpoints list to free chat models. */
export function endpointCandidates(json: unknown): EndpointCandidate[] {
  const artifacts = (json as { artifacts?: EndpointArtifact[] }).artifacts;
  if (!Array.isArray(artifacts)) return [];
  const seen = new Map<string, EndpointCandidate>();
  for (const a of artifacts) {
    if (!a?.name || !a.orgName || !a.publisher) continue;
    const labels = (a.labels ?? []).map((l) => l.toLowerCase());
    if (!labels.includes("chat") || !labels.includes("free endpoint")) continue;
    const id = `${a.publisher}/${a.name}`;
    if (seen.has(id)) continue;
    const ms = a.createdDate ? Date.parse(a.createdDate) : NaN;
    seen.set(id, {
      id,
      created: Number.isNaN(ms) ? 0 : Math.floor(ms / 1000),
      ownedBy: a.publisher,
      orgName: a.orgName,
      name: a.name,
    });
  }
  return [...seen.values()];
}

/** Name candidates for an OpenAI id, bare name then dots→underscores. */
export function slugCandidates(id: string): string[] {
  const name = id.split("/", 2)[1] ?? id;
  const underscored = name.replaceAll(".", "_");
  return name === underscored ? [name] : [name, underscored];
}

/** Fetch an endpoint's deploy route. Null when the endpoint is undeployed
 * (404 or no nvcfFunctionId). */
async function fetchSpec(
  orgName: string,
  name: string,
  fetchImpl: CatalogFetch,
): Promise<{
  namespace: string;
  functionId: string;
  params?: string[];
} | null> {
  try {
    const r = await fetchImpl(`${ENDPOINTS_BASE}/${orgName}/${name}/spec`, {
      headers: API_HEADERS,
      signal: AbortSignal.timeout(20_000),
    });
    if (!r.ok) return null;
    const spec = (await r.json()) as EndpointSpec;
    if (!spec.namespace || !spec.nvcfFunctionId) return null;
    return {
      namespace: spec.namespace,
      functionId: spec.nvcfFunctionId,
      params: specParams(spec.openAPISpec),
    };
  } catch {
    return null;
  }
}

async function fetchEndpoints(fetchImpl: CatalogFetch): Promise<unknown> {
  const r = await fetchImpl(ENDPOINTS_URL, {
    headers: API_HEADERS,
    signal: AbortSignal.timeout(30_000),
  });
  if (!r.ok) throw new Error(`endpoints list ${r.status}`);
  return r.json();
}

/** Resolve a model's deploy route by matching its name against the endpoints
 * list, then reading the spec. modelId = {namespace}/{endpoint name}. */
export async function resolveModelRoute(
  id: string,
  fetchImpl: CatalogFetch = fetch,
): Promise<ModelRoute | null> {
  try {
    const json = await fetchEndpoints(fetchImpl);
    const artifacts =
      (json as { artifacts?: EndpointArtifact[] }).artifacts ?? [];
    const names = slugCandidates(id);
    const publisher = id.split("/", 2)[0];
    const artifact = artifacts.find(
      (a) => a?.name && names.includes(a.name) && a.publisher === publisher,
    );
    if (!artifact) return null;
    const spec = await fetchSpec(artifact.orgName, artifact.name, fetchImpl);
    if (!spec) return null;
    return {
      modelId: `${spec.namespace}/${artifact.name}`,
      functionId: spec.functionId,
    };
  } catch {
    return null;
  }
}

export interface CatalogResult {
  entries: CatalogEntry[];
}

export type CatalogEvent =
  | { type: "list-done"; count: number }
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

/** Build the servable catalog: one endpoints list fetch, then a spec fetch
 * per free chat model to resolve its deploy route. */
export async function buildCatalog(opts?: {
  fetchImpl?: CatalogFetch;
  concurrency?: number;
  onEvent?: (e: CatalogEvent) => void;
}): Promise<CatalogResult> {
  const fetchImpl: CatalogFetch = opts?.fetchImpl ?? fetch;
  const onEvent = opts?.onEvent;

  const candidates = endpointCandidates(await fetchEndpoints(fetchImpl));
  onEvent?.({ type: "list-done", count: candidates.length });

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
      const spec = await fetchSpec(m.orgName, m.name, fetchImpl);
      if (!spec) {
        emit("dropped", "no deployment spec");
        return null;
      }
      kept++;
      emit("kept");
      return {
        id: m.id,
        slug: m.name,
        namespace: spec.namespace,
        functionId: spec.functionId,
        created: m.created,
        ownedBy: m.ownedBy,
        params: spec.params,
      } as CatalogEntry;
    },
  );

  onEvent?.({ type: "fetch-end", total, kept, dropped: total - kept });

  const sorted = entries
    .filter((e): e is CatalogEntry => e !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
  return { entries: sorted };
}
