import { BrowserSession } from "./browser";
import { buildCatalog, resolveModelRoute } from "./catalog";
import { env } from "./constants";
import { createServer } from "./server";
import { ThinkingCache } from "./thinking-cache";
import { TokenPool } from "./token-pool";
import { Upstream } from "./upstream";

const session = new BrowserSession({ executablePath: env.chromiumPath });
const pool = new TokenPool(session, env.poolSize);
const upstream = new Upstream();

// Catalog is best-effort: if NVIDIA's list is unreachable, resolve a deploy
// route for the default model dynamically so the proxy still boots.
let catalog: Awaited<ReturnType<typeof buildCatalog>> = [];
let defaultRoute: { modelId: string; functionId: string } | undefined;
try {
  catalog = await buildCatalog();
  console.log(
    `nim-playground-provider: catalog ready (${catalog.length} text-capable models)`,
  );
} catch (e) {
  console.warn(
    `nim-playground-provider: catalog unavailable (${(e as Error).message}), resolving default model`,
  );
}
if (catalog.length === 0) {
  defaultRoute = (await resolveModelRoute(env.model)) ?? undefined;
  if (defaultRoute) {
    console.log(
      `nim-playground-provider: resolved default route for ${env.model} (${defaultRoute.modelId})`,
    );
  } else {
    console.warn(
      `nim-playground-provider: could not resolve a route for ${env.model}; chat requests will fail`,
    );
  }
}

const cache = new ThinkingCache(env.thinkingCacheFile);
const server = createServer({
  pool,
  upstream,
  model: env.model,
  catalog,
  defaultRoute,
  cache,
});

console.log(
  `nim-playground-provider listening on http://localhost:${env.port} (pool=${env.poolSize}, default=${env.model}, thinking-cache=${env.thinkingCacheFile})`,
);

const stop = async () => {
  cache.flush();
  await server.stop(true);
  await session.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
