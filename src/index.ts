import { BrowserSession } from "./browser";
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

const server = createServer({ pool, upstream, model: env.model });

console.log(
  `nim-playground-provider listening on http://localhost:${env.port} (pool=${env.poolSize}, model=${env.model})`,
);

const stop = async () => {
  await server.stop(true);
  await session.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
