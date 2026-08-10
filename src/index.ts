import { BrowserSession } from "./browser";
import { buildCatalog } from "./catalog";
import { env } from "./constants";
import { createServer } from "./server";
import { TokenPool } from "./token-pool";
import { Upstream } from "./upstream";

const session = new BrowserSession({ executablePath: env.chromiumPath });
const pool = new TokenPool(session, env.poolSize);
const upstream = new Upstream({
  modelId: env.modelId,
  functionId: env.functionId,
});

// Catalog is best-effort: if NVIDIA's list is unreachable, fall back to the
// single configured default model so the proxy still boots.
let catalog: Awaited<ReturnType<typeof buildCatalog>> = [];
try {
  catalog = await buildCatalog();
  console.log(
    `nim-playground-provider: catalog ready (${catalog.length} text-capable models)`,
  );
} catch (e) {
  console.warn(
    `nim-playground-provider: catalog unavailable (${(e as Error).message}), using default model only`,
  );
}

const server = createServer({ pool, upstream, model: env.model, catalog });

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
