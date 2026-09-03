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
import {
  createDirectEgressCoordinator,
  createRuntimeEpochFactory,
  type EgressCoordinator,
  RotatingEgressCoordinator,
} from "./egress.ts";
import { assertProxyModeConcurrency, loadProxyFile } from "./proxy-list.ts";
import { createServer } from "./server.ts";
import { TokenPool } from "./token-pool.ts";
import type { CatalogEntry, ModelRoute } from "./types.ts";
import { Upstream } from "./upstream.ts";

const TAG = "nim-playground-provider:";
const shortRouteId = (routeId: string) => routeId.slice(0, 12);

console.log(`${TAG} running ${SERVER_VERSION}`);

const proxyFile = await loadProxyFile(env.proxyFile);
assertProxyModeConcurrency(proxyFile, env.upstreamConcurrency);
if (proxyFile.state === "loaded") {
  console.log(
    `${TAG} loaded ${proxyFile.routes.length} proxy routes (${proxyFile.rejectedLines.length} rejected lines)`,
  );
} else if (proxyFile.state === "unusable") {
  const reason =
    proxyFile.errorCategory ??
    (proxyFile.rejectedLines.length > 0 ? "no valid routes" : "empty file");
  console.warn(
    `${TAG} proxy file is unusable (${reason}, routes=0, rejected=${proxyFile.rejectedLines.length}); using direct fallback`,
  );
}
for (const item of proxyFile.rejectedLines) {
  console.warn(`${TAG} ignored proxy line ${item.line} (${item.reason})`);
}

const lightpandaPath = detectLightpanda();
let directSession: BrowserSession | null = null;
let directPool: TokenPool | null = null;
let egress: EgressCoordinator;
if (proxyFile.state === "loaded") {
  egress = new RotatingEgressCoordinator({
    routes: proxyFile.routes,
    factory: createRuntimeEpochFactory({
      lightpandaPath,
      poolSize: env.poolSize,
      headersTimeoutMs: env.upstreamHeadersTimeoutMs,
      onWarm: (routeId, warm) =>
        console.log(
          `${TAG} token pool ready (route=${shortRouteId(routeId)}, warm=${warm})`,
        ),
      onError: (routeId, error) =>
        console.warn(
          `${TAG} token pool refresh failed (route=${shortRouteId(routeId)}, error=${error.message}); retrying`,
        ),
    }),
    baseBackoffMs: env.upstreamBackoffMs,
    maxBackoffMs: env.upstreamMaxBackoffMs,
    onEvent: (event) => {
      if (event.type === "activated") {
        console.log(
          `${TAG} egress activated (route=${shortRouteId(event.routeId)}, epoch=${event.epochId})`,
        );
      } else {
        console.warn(
          `${TAG} egress cooling (route=${shortRouteId(event.routeId)}, outcome=${event.outcome}, duration=${event.durationMs}ms)`,
        );
      }
    },
  });
} else {
  directSession = new BrowserSession({ lightpandaPath });
  directPool = new TokenPool(directSession, env.poolSize, {
    onWarm: (warm) => console.log(`${TAG} token pool ready (${warm} warm)`),
    onError: (error) =>
      console.warn(
        `${TAG} token pool refresh failed (${error.message}); retrying`,
      ),
  });
  const upstream = new Upstream({
    headersTimeoutMs: env.upstreamHeadersTimeoutMs,
  });
  egress = createDirectEgressCoordinator(directPool, upstream);
}

if (
  env.apiKeys.length === 0 &&
  env.host !== "127.0.0.1" &&
  env.host !== "localhost"
) {
  console.warn(
    `${TAG} warning: listening on ${env.host} with no API_KEY; anyone who can reach this port can use it`,
  );
}

const CATALOG_REFRESH_MS = 1000 * 60 * 60 * 24;
let catalog: CatalogEntry[] = [];
let catalogState: "idle" | "fetching" | "ready" = "idle";
let lastCatalogAttempt = 0;
const CATALOG_RETRY_MS = 60_000;

let defaultRoute: ModelRoute | undefined;
const deriveDefaultRoute = (): ModelRoute | undefined => {
  const entry = catalog.find((item) => item.id === env.model);
  return entry
    ? {
        modelId: `${entry.namespace ?? NAMESPACE}/${entry.slug}`,
        functionId: entry.functionId,
        params: entry.params,
      }
    : undefined;
};

const logCatalogEvent = (event: CatalogEvent) => {
  switch (event.type) {
    case "list-done":
      console.log(
        `${TAG} discovered ${event.count} free chat models from endpoints list`,
      );
      return;
    case "fetch-start":
      console.log(
        `${TAG} fetching ${event.count} model specs (concurrency=${event.concurrency})...`,
      );
      return;
    case "model":
      if (event.outcome === "kept") {
        console.log(
          `${TAG} fetched ${event.fetched}/${event.total} models (${event.id})`,
        );
      } else {
        console.log(
          `${TAG} fetched ${event.fetched}/${event.total} models (${event.id}) — dropped: ${event.reason}`,
        );
      }
      return;
    case "fetch-end":
      console.log(
        `${TAG} fetched ${event.total}/${event.total} models (${event.kept} kept, ${event.dropped} dropped)`,
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
  } catch (error) {
    catalogState = "idle";
    console.warn(`${TAG} catalog refresh failed (${(error as Error).message})`);
  }
};
const getCatalog = () => {
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

if (directPool) {
  console.log(`${TAG} warming token pool (size=${env.poolSize})`);
  directPool.prewarm();
} else {
  console.log(`${TAG} proxy token pool activates with the first request`);
}

const server = await createServer({
  egress,
  model: env.model,
  getCatalog,
  getDefaultRoute: () => defaultRoute,
});

console.log(
  `${TAG} listening on ${server.url} (pool=${env.poolSize}, upstream-concurrency=${env.upstreamConcurrency}, min-interval=${env.upstreamMinIntervalMs}ms, egress=${egress.proxyMode ? "rotating" : "direct"}, default=${env.model})`,
);

let stopPromise: Promise<void> | null = null;
const stop = (): Promise<void> => {
  if (stopPromise) return stopPromise;
  stopPromise = (async () => {
    server.beginShutdown();
    await egress.drain(30_000);
    await server.stop(true);
    await egress.close();
    directPool?.close();
    await directSession?.close();
  })().catch((error) => {
    console.error(`${TAG} shutdown failed (${(error as Error).message})`);
    process.exitCode = 1;
  });
  return stopPromise;
};
process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
