import { BrowserSession } from "./browser";
import { buildCatalog, resolveModelRoute } from "./catalog";
import { env } from "./constants";
import { createServer } from "./server";
import { TokenPool } from "./token-pool";
import type { CatalogEntry, ModelRoute } from "./types";
import { Upstream } from "./upstream";

const CATALOG_REFRESH_MS = 6 * 60 * 60 * 1000;

const session = new BrowserSession({ executablePath: env.chromiumPath });
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

// Catalog is best-effort: built in the background so boot never blocks on
// NVIDIA, refreshed on a TTL so the model list does not go stale.
let catalog: CatalogEntry[] = [];
const refreshCatalog = async () => {
  try {
    catalog = await buildCatalog();
    console.log(
      `nim-playground-provider: catalog ready (${catalog.length} text-capable models)`,
    );
  } catch (e) {
    console.warn(
      `nim-playground-provider: catalog refresh failed (${(e as Error).message})`,
    );
  }
};
void refreshCatalog().then(() =>
  setInterval(refreshCatalog, CATALOG_REFRESH_MS),
);

const server = createServer({
  pool,
  upstream,
  model: env.model,
  getCatalog: () => catalog,
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
