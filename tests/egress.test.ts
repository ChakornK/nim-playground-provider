import { expect, test } from "bun:test";
import {
  AllRoutesCoolingError,
  EgressClosedError,
  EgressPreparationError,
  type EgressRoute,
  type EpochFactory,
  type EpochResources,
  type GenerationOutcome,
  RotatingEgressCoordinator,
} from "../src/egress.ts";
import type { ProxyDefinition } from "../src/proxy-list.ts";
import type { UpstreamChatParams } from "../src/types.ts";

interface FakeEpoch extends EpochResources {
  routeId: string;
  epochId: number;
  closed: number;
  tokenCalls: number;
  chatCalls: number;
}

const proxy = (id: string, octet: number): ProxyDefinition => ({
  id,
  scheme: "http",
  host: `8.8.8.${octet}`,
  port: 3000 + octet,
  canonicalUrl: `http://8.8.8.${octet}:${3000 + octet}`,
});

const chatParams = (): UpstreamChatParams => ({
  token: "P1_test",
  messages: [{ role: "user", content: "hi" }],
  model: "moonshotai/kimi-k3",
  route: { modelId: "namespace/kimi-k3", functionId: "function-id" },
  enableThinking: false,
  stream: false,
});

const fakeFactory = (opts?: {
  failRouteIds?: Set<string>;
  token?: (route: EgressRoute, signal?: AbortSignal) => Promise<string>;
}) => {
  const epochs: FakeEpoch[] = [];
  const factory: EpochFactory = {
    async create(route, epochId) {
      if (opts?.failRouteIds?.has(route.id))
        throw new Error("activation failed");
      const epoch: FakeEpoch = {
        routeId: route.id,
        epochId,
        closed: 0,
        tokenCalls: 0,
        chatCalls: 0,
        async acquireToken(signal) {
          this.tokenCalls++;
          return opts?.token?.(route, signal) ?? `P1_${route.id}_${epochId}`;
        },
        async chat() {
          this.chatCalls++;
          return new Response("{}", {
            headers: { "content-type": "application/json" },
          });
        },
        async invalidateCaptcha() {},
        async close() {
          this.closed++;
        },
      };
      epochs.push(epoch);
      return epoch;
    },
  };
  return { factory, epochs };
};

const coordinator = (
  factory: EpochFactory,
  now: () => number,
  routes = [proxy("a", 1), proxy("b", 2)],
) =>
  new RotatingEgressCoordinator({
    routes,
    factory,
    baseBackoffMs: 100,
    maxBackoffMs: 800,
    now,
  });

test("successful and neutral outcomes keep one sticky route epoch", async () => {
  let time = 0;
  const fake = fakeFactory();
  const egress = coordinator(fake.factory, () => time);
  try {
    const first = await egress.acquire();
    expect(first.routeId).toBe("a");
    expect(await first.acquireToken()).toBe("P1_a_1");
    expect((await first.chat(chatParams())).status).toBe(200);
    await first.finish("success");

    const second = await egress.acquire();
    expect(second.routeId).toBe("a");
    expect(second.epochId).toBe(first.epochId);
    await second.finish("neutral");
    expect(fake.epochs).toHaveLength(1);
    time++;
  } finally {
    await egress.close();
  }
});

test("route failure cools the route and rotates in file order", async () => {
  const time = 0;
  const fake = fakeFactory();
  const egress = coordinator(fake.factory, () => time);
  try {
    const first = await egress.acquire();
    await first.finish("pre_dispatch_route_failure");
    const second = await egress.acquire();
    expect(second.routeId).toBe("b");
    expect(second.epochId).toBeGreaterThan(first.epochId);
    await second.finish("success");

    const health = egress.getHealthSnapshot();
    expect(health.find((item) => item.routeId === "a")).toMatchObject({
      consecutiveFailures: 1,
      cooldownUntil: 100,
    });
    expect(health.find((item) => item.routeId === "b")).toMatchObject({
      consecutiveFailures: 0,
    });
  } finally {
    await egress.close();
  }
});

test("direct fallback yields to a recovered external route", async () => {
  let time = 0;
  const fake = fakeFactory();
  const egress = coordinator(fake.factory, () => time);
  try {
    const first = await egress.acquire();
    await first.finish("pre_dispatch_route_failure");
    const second = await egress.acquire();
    await second.finish("pre_dispatch_route_failure");

    const direct = await egress.acquire();
    expect(direct.routeId).toBe("direct");
    await direct.finish("neutral");

    time = 101;
    const recovered = await egress.acquire();
    expect(recovered.routeKind).toBe("proxy");
    expect(recovered.routeId).toBe("a");
    await recovered.finish("success");
  } finally {
    await egress.close();
  }
});

test("provider-global outcome preserves route health", async () => {
  let time = 0;
  const fake = fakeFactory();
  const egress = coordinator(fake.factory, () => time);
  try {
    const lease = await egress.acquire();
    await lease.finish("provider_global_failure");
    expect(egress.getHealthSnapshot()[0]).toMatchObject({
      routeId: "a",
      consecutiveFailures: 0,
      cooldownUntil: 0,
      active: true,
    });
    time++;
  } finally {
    await egress.close();
  }
});

test("ambiguous outcome cools its route but does not replay chat", async () => {
  let time = 0;
  const fake = fakeFactory();
  const egress = coordinator(fake.factory, () => time);
  try {
    const lease = await egress.acquire();
    await lease.chat(chatParams());
    await lease.finish("ambiguous_post_dispatch_failure");
    expect(fake.epochs[0]?.chatCalls).toBe(1);
    expect(egress.getHealthSnapshot()[0]?.consecutiveFailures).toBe(1);
    time++;
  } finally {
    await egress.close();
  }
});

test("all cooled proxy and direct routes report the shortest cooldown", async () => {
  const time = 0;
  const fake = fakeFactory();
  const egress = coordinator(fake.factory, () => time);
  try {
    for (const outcome of [
      "pre_dispatch_route_failure",
      "pre_dispatch_route_failure",
      "ambiguous_post_dispatch_failure",
    ] satisfies GenerationOutcome[]) {
      const lease = await egress.acquire();
      await lease.finish(outcome);
    }
    try {
      await egress.acquire();
      throw new Error("expected cooldown");
    } catch (error) {
      expect(error).toBeInstanceOf(AllRoutesCoolingError);
      expect((error as AllRoutesCoolingError).retryAfterMs).toBe(100);
    }
  } finally {
    await egress.close();
  }
});

test("activation failover attempts at most three distinct routes", async () => {
  let time = 0;
  const routes = [proxy("a", 1), proxy("b", 2), proxy("c", 3), proxy("d", 4)];
  const fake = fakeFactory({ failRouteIds: new Set(["a", "b", "c", "d"]) });
  const egress = new RotatingEgressCoordinator({
    routes,
    factory: fake.factory,
    baseBackoffMs: 100,
    maxBackoffMs: 800,
    maxActivationAttempts: 3,
    now: () => time,
  });
  let creates = 0;
  const original = fake.factory.create.bind(fake.factory);
  fake.factory.create = async (route, epochId) => {
    creates++;
    return original(route, epochId);
  };
  try {
    await expect(egress.acquire()).rejects.toBeInstanceOf(
      EgressPreparationError,
    );
    expect(creates).toBe(3);
    time++;
  } finally {
    await egress.close();
  }
});

test("late token from a finished epoch is fenced", async () => {
  let resolveToken: ((token: string) => void) | undefined;
  const pendingToken = new Promise<string>((resolve) => {
    resolveToken = resolve;
  });
  const fake = fakeFactory({ token: async () => pendingToken });
  const egress = coordinator(fake.factory, () => 0);
  try {
    const lease = await egress.acquire();
    const token = lease.acquireToken();
    await lease.finish("pre_dispatch_route_failure");
    resolveToken?.("P1_late");
    await expect(token).rejects.toBeInstanceOf(EgressClosedError);
  } finally {
    await egress.close();
  }
});

test("drain aborts an active lease after its deadline", async () => {
  let sawAbort = false;
  const fake = fakeFactory({
    token: async (_route, signal) =>
      new Promise<string>((_resolve, reject) => {
        signal?.addEventListener(
          "abort",
          () => {
            sawAbort = true;
            reject(new DOMException("aborted", "AbortError"));
          },
          { once: true },
        );
      }),
  });
  const egress = new RotatingEgressCoordinator({
    routes: [proxy("a", 1)],
    factory: fake.factory,
    baseBackoffMs: 100,
    maxBackoffMs: 800,
    sleep: async () => {},
  });
  const lease = await egress.acquire();
  const token = lease.acquireToken();
  expect(await egress.drain(30_000)).toBe(false);
  await expect(token).rejects.toMatchObject({ name: "AbortError" });
  expect(sawAbort).toBe(true);
  await lease.finish("neutral");
  await egress.close();
});

test("generated success and neutral sequences never rotate", async () => {
  for (let seed = 0; seed < 100; seed++) {
    const fake = fakeFactory();
    const egress = coordinator(fake.factory, () => seed);
    const outcomes: GenerationOutcome[] = Array.from(
      { length: 1 + (seed % 8) },
      (_, index) => ((seed + index) % 2 === 0 ? "success" : "neutral"),
    );
    let routeId: string | undefined;
    for (const outcome of outcomes) {
      const lease = await egress.acquire();
      routeId ??= lease.routeId;
      expect(lease.routeId).toBe(routeId);
      await lease.finish(outcome);
    }
    expect(fake.epochs).toHaveLength(1);
    await egress.close();
  }
});
