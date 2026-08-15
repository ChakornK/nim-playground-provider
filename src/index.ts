import { BrowserSession } from "./browser.ts";
import { buildCatalog, resolveModelRoute } from "./catalog.ts";
import { env } from "./constants.ts";
import { createServer } from "./server.ts";
import { TokenPool } from "./token-pool.ts";
import type { CatalogEntry, ModelRoute } from "./types.ts";
import { Upstream } from "./upstream.ts";

const session = new BrowserSession({ lightpandaPath: env.lightpandaPath });
const pool = new TokenPool(session, env.poolSize);
const upstream = new Upstream();

// Resolve the default route first so the proxy serves immediately even if the
// full catalog takes time to build or NVIDIA's list is unreachable.
const defaultRoute: ModelRoute | undefined =
  (await resolveModelRoute(env.model)) ?? undefined;
if (defaultRoute) {
  console.log(
    `nim-playground-provider: resolved default route for ${env.model} (${defaultRoute.modelId})`,
  );
} else {
  console.warn(
    `nim-playground-provider: could not resolve a route for ${env.model}; chat requests will fail`,
  );
}

// Catalog is fetched lazily on first /v1/models request to keep startup light.
const DEFAULT_REFRESH_MS = 6 * 60 * 60 * 1000;
let catalog: CatalogEntry[] = [];
let catalogState: "idle" | "fetching" | "ready" = "idle";
let catalogRefreshMs = DEFAULT_REFRESH_MS;
const refreshCatalog = async () => {
  if (catalogState === "fetching") return;
  catalogState = "fetching";
  try {
    const result = await buildCatalog();
    catalog = result.entries;
    catalogRefreshMs = result.refreshMs;
    catalogState = "ready";
    console.log(
      `nim-playground-provider: catalog ready (${catalog.length} text-capable models)`,
    );
    setInterval(refreshCatalog, catalogRefreshMs);
  } catch (e) {
    catalogState = "idle";
    console.warn(
      `nim-playground-provider: catalog refresh failed (${(e as Error).message})`,
    );
  }
};
const getCatalog = () => {
  if (catalogState === "idle") void refreshCatalog();
  return catalog;
};

pool.prewarm();

const server = await createServer({
  pool,
  upstream,
  model: env.model,
  getCatalog,
  defaultRoute,
});

console.log(
  `nim-playground-provider listening on http://localhost:${env.port} (pool=${env.poolSize}, default=${env.model})`,
);

const stop = async () => {
  await server.stop(true);
  await session.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
