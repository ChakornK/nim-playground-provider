import { BrowserSession } from "./browser.ts";
import {
  buildCatalog,
  type CatalogEvent,
  resolveModelRoute,
} from "./catalog.ts";
import {
  detectLightpanda,
  env,
  NAMESPACE,
  SERVER_VERSION,
} from "./constants.ts";
import { createServer } from "./server.ts";
import { TokenPool } from "./token-pool.ts";
import type { CatalogEntry, ModelRoute } from "./types.ts";
import { Upstream } from "./upstream.ts";

const TAG = "nim-playground-provider:";

console.log(`${TAG} running ${SERVER_VERSION}`);

const lightpandaPath = detectLightpanda();
const session = new BrowserSession({ lightpandaPath });
const pool = new TokenPool(session, env.poolSize, {
  onWarm: (warm) => console.log(`${TAG} token pool ready (${warm} warm)`),
  onError: (error) =>
    console.warn(
      `${TAG} token pool refresh failed (${error.message}); retrying`,
    ),
});
const upstream = new Upstream();

if (
  env.apiKeys.length === 0 &&
  env.host !== "127.0.0.1" &&
  env.host !== "localhost"
) {
  console.warn(
    `${TAG} warning: listening on ${env.host} with no API_KEY; anyone who can reach this port can use it`,
  );
}

// Catalog awaited at startup, failed build re-triggers on /v1/models, then
// refreshes on an interval.
const CATALOG_REFRESH_MS = 1000 * 60 * 60 * 24;
let catalog: CatalogEntry[] = [];
let catalogState: "idle" | "fetching" | "ready" = "idle";
let lastCatalogAttempt = 0;
const CATALOG_RETRY_MS = 60_000;

let defaultRoute: ModelRoute | undefined;
const deriveDefaultRoute = (): ModelRoute | undefined => {
  const entry = catalog.find((m) => m.id === env.model);
  return entry
    ? {
        modelId: `${entry.namespace ?? NAMESPACE}/${entry.slug}`,
        functionId: entry.functionId,
      }
    : undefined;
};

const logCatalogEvent = (e: CatalogEvent) => {
  switch (e.type) {
    case "list-done":
      console.log(
        `${TAG} discovered ${e.count} free chat models from endpoints list`,
      );
      return;
    case "fetch-start":
      console.log(
        `${TAG} fetching ${e.count} model specs (concurrency=${e.concurrency})...`,
      );
      return;
    case "model":
      if (e.outcome === "kept") {
        console.log(`${TAG} fetched ${e.fetched}/${e.total} models (${e.id})`);
      } else {
        console.log(
          `${TAG} fetched ${e.fetched}/${e.total} models (${e.id}) — dropped: ${e.reason}`,
        );
      }
      return;
    case "fetch-end":
      console.log(
        `${TAG} fetched ${e.total}/${e.total} models (${e.kept} kept, ${e.dropped} dropped)`,
      );
      return;
  }
};

const refreshCatalog = async () => {
  if (catalogState === "fetching") return;
  catalogState = "fetching";
  lastCatalogAttempt = Date.now();
  try {
    const result = await buildCatalog({
      concurrency: 8,
      onEvent: logCatalogEvent,
    });
    catalog = result.entries;
    catalogState = "ready";
    defaultRoute = deriveDefaultRoute() ?? defaultRoute;
    console.log(`${TAG} catalog ready (${catalog.length} text-capable models)`);
  } catch (e) {
    catalogState = "idle";
    console.warn(`${TAG} catalog refresh failed (${(e as Error).message})`);
  }
};
const getCatalog = () => {
  // Failed builds wait out the backoff before re-triggering.
  if (
    catalogState === "idle" &&
    Date.now() - lastCatalogAttempt > CATALOG_RETRY_MS
  ) {
    void refreshCatalog();
  }
  return catalog;
};

await refreshCatalog();
setInterval(refreshCatalog, CATALOG_REFRESH_MS).unref();

// Falls back to a direct lookup when the catalog build failed.
defaultRoute ??= (await resolveModelRoute(env.model)) ?? undefined;
if (defaultRoute) {
  console.log(
    `${TAG} resolved default route for ${env.model} (${defaultRoute.modelId})`,
  );
} else {
  console.warn(
    `${TAG} could not resolve a route for ${env.model}; chat requests will fail`,
  );
}

console.log(`${TAG} warming token pool (size=${env.poolSize})`);
pool.prewarm();

const server = await createServer({
  pool,
  upstream,
  model: env.model,
  getCatalog,
  getDefaultRoute: () => defaultRoute,
});

console.log(
  `${TAG} listening on ${server.url} (pool=${env.poolSize}, default=${env.model})`,
);

const stop = async () => {
  await server.stop(true);
  await session.close();
  process.exit(0);
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
