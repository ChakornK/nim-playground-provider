import { BrowserSession } from "./browser.ts";
import { SocksConnectAdapter } from "./proxy-adapter.ts";
import type { ProxyDefinition } from "./proxy-list.ts";
import { createRouteFetchTransport } from "./route-fetch.ts";
import { TokenPool } from "./token-pool.ts";
import type { UpstreamChatParams } from "./types.ts";
import { Upstream } from "./upstream.ts";

export type GenerationOutcome =
  | "success"
  | "neutral"
  | "pre_dispatch_route_failure"
  | "provider_global_failure"
  | "ambiguous_post_dispatch_failure"
  | "definitive_captcha_rejection";

export type EgressRoute =
  | { id: "direct"; kind: "direct" }
  | { id: string; kind: "proxy"; definition: ProxyDefinition };

export interface EpochResources {
  acquireToken(signal?: AbortSignal): Promise<string>;
  chat(params: UpstreamChatParams): Promise<Response>;
  invalidateCaptcha(): Promise<void>;
  close(): Promise<void>;
}

export interface EpochFactory {
  create(route: EgressRoute, epochId: number): Promise<EpochResources>;
}

export interface GenerationLease {
  readonly epochId: number;
  readonly routeId: string;
  readonly routeKind: EgressRoute["kind"];
  readonly signal: AbortSignal;
  acquireToken(signal?: AbortSignal): Promise<string>;
  chat(params: UpstreamChatParams): Promise<Response>;
  invalidateCaptcha(): Promise<void>;
  finish(outcome: GenerationOutcome): Promise<void>;
}

export interface EgressCoordinator {
  readonly proxyMode: boolean;
  acquire(signal?: AbortSignal): Promise<GenerationLease>;
  beginShutdown(): void;
  drain(timeoutMs?: number): Promise<boolean>;
  close(): Promise<void>;
}

export interface RouteHealthSnapshot {
  routeId: string;
  consecutiveFailures: number;
  cooldownUntil: number;
  active: boolean;
}

export type EgressEvent =
  | { type: "activated"; routeId: string; epochId: number }
  | {
      type: "cooldown";
      routeId: string;
      outcome: GenerationOutcome;
      durationMs: number;
    };

export interface RotatingEgressOpts {
  routes: readonly ProxyDefinition[];
  factory: EpochFactory;
  baseBackoffMs: number;
  maxBackoffMs: number;
  maxActivationAttempts?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onEvent?: (event: EgressEvent) => void;
}

export class EgressClosedError extends Error {
  constructor() {
    super("egress coordinator is closed");
    this.name = "EgressClosedError";
  }
}

export class EgressBusyError extends Error {
  constructor() {
    super("an egress generation lease is already active");
    this.name = "EgressBusyError";
  }
}

export class AllRoutesCoolingError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("all egress routes are cooling down");
    this.name = "AllRoutesCoolingError";
    this.retryAfterMs = Math.max(0, retryAfterMs);
  }
}

export class EgressPreparationError extends Error {
  constructor() {
    super("unable to activate an egress route");
    this.name = "EgressPreparationError";
  }
}

interface RouteHealth {
  consecutiveFailures: number;
  cooldownUntil: number;
}

interface ActiveEpoch {
  id: number;
  route: EgressRoute;
  resources: EpochResources;
}

const directRoute: EgressRoute = { id: "direct", kind: "direct" };

const abortError = (): Error => {
  if (typeof DOMException !== "undefined") {
    return new DOMException("request aborted", "AbortError");
  }
  const error = new Error("request aborted");
  error.name = "AbortError";
  return error;
};

const combinedSignal = (
  requestSignal: AbortSignal | undefined,
  leaseSignal: AbortSignal,
): AbortSignal => {
  if (!requestSignal) return leaseSignal;
  return AbortSignal.any([requestSignal, leaseSignal]);
};

export function createDirectEgressCoordinator(
  pool: TokenPool,
  upstream: Upstream,
): EgressCoordinator {
  let accepting = true;
  let closed = false;
  let nextEpochId = 1;
  const active = new Map<
    number,
    { controller: AbortController; finished: Promise<void>; resolve(): void }
  >();

  return {
    proxyMode: false,
    async acquire(requestSignal) {
      if (!accepting || closed) throw new EgressClosedError();
      if (requestSignal?.aborted) throw abortError();
      const epochId = nextEpochId++;
      const controller = new AbortController();
      let resolveFinished: (() => void) | undefined;
      const finished = new Promise<void>((resolve) => {
        resolveFinished = resolve;
      });
      active.set(epochId, {
        controller,
        finished,
        resolve: () => resolveFinished?.(),
      });
      let leaseFinished = false;
      const assertOpen = () => {
        if (leaseFinished || closed) throw new EgressClosedError();
      };
      return {
        epochId,
        routeId: "direct",
        routeKind: "direct",
        signal: controller.signal,
        acquireToken: async (signal) => {
          assertOpen();
          const token = await pool.acquire(
            combinedSignal(signal ?? requestSignal, controller.signal),
          );
          assertOpen();
          return token;
        },
        chat: async (params) => {
          assertOpen();
          const response = await upstream.chat({
            ...params,
            signal: combinedSignal(
              params.signal ?? requestSignal,
              controller.signal,
            ),
          });
          try {
            assertOpen();
            return response;
          } catch (error) {
            void response.body?.cancel().catch(() => {});
            throw error;
          }
        },
        invalidateCaptcha: async () => {
          assertOpen();
          await pool.invalidate();
          assertOpen();
        },
        finish: async () => {
          if (leaseFinished) return;
          leaseFinished = true;
          const entry = active.get(epochId);
          active.delete(epochId);
          entry?.resolve();
        },
      };
    },
    beginShutdown() {
      accepting = false;
    },
    async drain(timeoutMs = 30_000) {
      accepting = false;
      if (active.size === 0) return true;
      const finished = Promise.all(
        [...active.values()].map((item) => item.finished),
      );
      const completed = await Promise.race([
        finished.then(() => true),
        new Promise<boolean>((resolve) => {
          const timer = setTimeout(
            () => resolve(false),
            Math.max(0, timeoutMs),
          );
          timer.unref();
        }),
      ]);
      if (completed) return true;
      for (const entry of active.values()) entry.controller.abort();
      await Promise.race([
        finished,
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref();
        }),
      ]);
      return false;
    },
    async close() {
      if (closed) return;
      accepting = false;
      closed = true;
      for (const entry of active.values()) {
        entry.controller.abort();
        entry.resolve();
      }
      active.clear();
    },
  };
}

export interface RuntimeEpochFactoryOpts {
  lightpandaPath: string;
  poolSize: number;
  headersTimeoutMs: number;
  onWarm?: (routeId: string, warm: number) => void;
  onError?: (routeId: string, error: Error) => void;
}

export function createRuntimeEpochFactory(
  opts: RuntimeEpochFactoryOpts,
): EpochFactory {
  return {
    async create(route) {
      let adapter: SocksConnectAdapter | null = null;
      try {
        let adapterUrl: string | undefined;
        if (route.kind === "proxy" && route.definition.scheme !== "http") {
          adapter = new SocksConnectAdapter(route.definition);
          adapterUrl = await adapter.start();
        }
        const transport = createRouteFetchTransport({
          route: route.kind === "proxy" ? route.definition : undefined,
          socksAdapterUrl: adapterUrl,
          close: () => adapter?.close() ?? Promise.resolve(),
        });
        const session = new BrowserSession({
          lightpandaPath: opts.lightpandaPath,
          fetchImpl: transport.fetch,
          requireStealth: route.kind === "proxy",
        });
        const pool = new TokenPool(session, opts.poolSize, {
          onWarm: (warm) => opts.onWarm?.(route.id, warm),
          onError: (error) => opts.onError?.(route.id, error),
        });
        const upstream = new Upstream({
          headersTimeoutMs: opts.headersTimeoutMs,
          fetchImpl: transport.fetch,
        });
        pool.prewarm();

        let closed = false;
        return {
          acquireToken: (signal) => pool.acquire(signal),
          chat: (params) => upstream.chat(params),
          invalidateCaptcha: () => pool.invalidate(),
          close: async () => {
            if (closed) return;
            closed = true;
            pool.close();
            await session.close();
            await transport.close();
          },
        };
      } catch (error) {
        await adapter?.close();
        throw error;
      }
    },
  };
}

export class RotatingEgressCoordinator implements EgressCoordinator {
  readonly proxyMode = true;
  private readonly routes: EgressRoute[];
  private readonly factory: EpochFactory;
  private readonly baseBackoffMs: number;
  private readonly maxBackoffMs: number;
  private readonly maxActivationAttempts: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly onEvent?: (event: EgressEvent) => void;
  private readonly health = new Map<string, RouteHealth>();
  private active: ActiveEpoch | null = null;
  private activeLease = false;
  private activeLeaseController: AbortController | null = null;
  private activeFinished: Promise<void> = Promise.resolve();
  private resolveActiveFinished: (() => void) | null = null;
  private cursor = 0;
  private nextEpochId = 1;
  private accepting = true;
  private closed = false;
  private operationTail: Promise<void> = Promise.resolve();
  private closePromise: Promise<void> | null = null;

  constructor(opts: RotatingEgressOpts) {
    if (opts.routes.length === 0) {
      throw new Error("rotating egress requires at least one proxy route");
    }
    this.routes = opts.routes.map((definition) => ({
      id: definition.id,
      kind: "proxy" as const,
      definition,
    }));
    this.factory = opts.factory;
    this.baseBackoffMs = Math.max(0, opts.baseBackoffMs);
    this.maxBackoffMs = Math.max(this.baseBackoffMs, opts.maxBackoffMs);
    this.maxActivationAttempts = Math.max(
      1,
      Math.trunc(opts.maxActivationAttempts ?? 1),
    );
    this.now = opts.now ?? Date.now;
    this.sleep =
      opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.onEvent = opts.onEvent;
    for (const route of [...this.routes, directRoute]) {
      this.health.set(route.id, { consecutiveFailures: 0, cooldownUntil: 0 });
    }
  }

  acquire(signal?: AbortSignal): Promise<GenerationLease> {
    return this.withLock(async () => {
      if (!this.accepting || this.closed) throw new EgressClosedError();
      if (signal?.aborted) throw abortError();
      if (this.activeLease) throw new EgressBusyError();

      let activationAttempts = 0;
      while (activationAttempts < this.maxActivationAttempts) {
        const route = this.selectRoute();
        if (!route) throw new AllRoutesCoolingError(this.shortestCooldown());
        try {
          await this.ensureActive(route);
        } catch {
          if (signal?.aborted) throw abortError();
          this.coolRoute(route, "pre_dispatch_route_failure");
          activationAttempts++;
          if (activationAttempts >= this.maxActivationAttempts) {
            throw new EgressPreparationError();
          }
          continue;
        }

        const epoch = this.active;
        if (!epoch || epoch.route.id !== route.id) {
          throw new EgressPreparationError();
        }
        this.activeLease = true;
        const controller = new AbortController();
        this.activeLeaseController = controller;
        this.activeFinished = new Promise((resolve) => {
          this.resolveActiveFinished = resolve;
        });
        return this.createLease(epoch, controller, signal);
      }
      throw new EgressPreparationError();
    });
  }

  beginShutdown(): void {
    this.accepting = false;
  }

  async drain(timeoutMs = 30_000): Promise<boolean> {
    this.beginShutdown();
    if (!this.activeLease) return true;
    const completed = await Promise.race([
      this.activeFinished.then(() => true),
      this.sleep(Math.max(0, timeoutMs)).then(() => false),
    ]);
    if (completed) return true;
    this.activeLeaseController?.abort();
    await Promise.race([this.activeFinished, this.sleep(2_000)]);
    return false;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closePromise = this.withLock(async () => {
      this.accepting = false;
      this.closed = true;
      this.activeLeaseController?.abort();
      this.finishActiveLease();
      await this.closeActive();
    });
    return this.closePromise;
  }

  getHealthSnapshot(): RouteHealthSnapshot[] {
    return [...this.routes, directRoute].map((route) => {
      const health = this.healthFor(route);
      return {
        routeId: route.id,
        consecutiveFailures: health.consecutiveFailures,
        cooldownUntil: health.cooldownUntil,
        active: this.active?.route.id === route.id,
      };
    });
  }

  private createLease(
    epoch: ActiveEpoch,
    controller: AbortController,
    requestSignal?: AbortSignal,
  ): GenerationLease {
    let finished = false;
    const assertCurrent = () => {
      if (finished || this.active?.id !== epoch.id || this.closed) {
        throw new EgressClosedError();
      }
    };
    return {
      epochId: epoch.id,
      routeId: epoch.route.id,
      routeKind: epoch.route.kind,
      signal: controller.signal,
      acquireToken: async (signal) => {
        assertCurrent();
        const token = await epoch.resources.acquireToken(
          combinedSignal(signal ?? requestSignal, controller.signal),
        );
        assertCurrent();
        return token;
      },
      chat: async (params) => {
        assertCurrent();
        const response = await epoch.resources.chat({
          ...params,
          signal: combinedSignal(
            params.signal ?? requestSignal,
            controller.signal,
          ),
        });
        try {
          assertCurrent();
          return response;
        } catch (error) {
          void response.body?.cancel().catch(() => {});
          throw error;
        }
      },
      invalidateCaptcha: async () => {
        assertCurrent();
        await epoch.resources.invalidateCaptcha();
        assertCurrent();
      },
      finish: async (outcome) => {
        if (finished) return;
        finished = true;
        await this.withLock(async () => {
          if (this.active?.id === epoch.id) {
            if (outcome === "success") this.markHealthy(epoch.route);
            else if (
              outcome === "pre_dispatch_route_failure" ||
              outcome === "ambiguous_post_dispatch_failure" ||
              outcome === "definitive_captcha_rejection"
            ) {
              this.coolRoute(epoch.route, outcome);
              await this.closeActive();
            }
          }
          this.finishActiveLease();
        });
      },
    };
  }

  private finishActiveLease(): void {
    this.activeLease = false;
    this.activeLeaseController = null;
    const resolve = this.resolveActiveFinished;
    this.resolveActiveFinished = null;
    resolve?.();
  }

  private selectRoute(): EgressRoute | null {
    if (
      this.active?.route.kind === "proxy" &&
      this.isEligible(this.active.route)
    ) {
      return this.active.route;
    }
    const external = this.nextEligibleExternal();
    if (external) return external;
    if (this.isEligible(directRoute)) return directRoute;
    return null;
  }

  private nextEligibleExternal(): EgressRoute | null {
    for (let offset = 0; offset < this.routes.length; offset++) {
      const index = (this.cursor + offset) % this.routes.length;
      const route = this.routes[index];
      if (route && this.isEligible(route)) return route;
    }
    return null;
  }

  private async ensureActive(route: EgressRoute): Promise<void> {
    if (this.active?.route.id === route.id) return;
    await this.closeActive();
    const id = this.nextEpochId++;
    const resources = await this.factory.create(route, id);
    if (this.closed || !this.accepting) {
      await resources.close();
      throw new EgressClosedError();
    }
    this.active = { id, route, resources };
    this.onEvent?.({ type: "activated", routeId: route.id, epochId: id });
  }

  private async closeActive(): Promise<void> {
    const active = this.active;
    this.active = null;
    if (active) await active.resources.close();
  }

  private healthFor(route: EgressRoute): RouteHealth {
    const health = this.health.get(route.id);
    if (!health) throw new Error("missing route health");
    return health;
  }

  private isEligible(route: EgressRoute): boolean {
    return this.healthFor(route).cooldownUntil <= this.now();
  }

  private markHealthy(route: EgressRoute): void {
    const health = this.healthFor(route);
    health.consecutiveFailures = 0;
    health.cooldownUntil = 0;
  }

  private coolRoute(route: EgressRoute, outcome: GenerationOutcome): void {
    const health = this.healthFor(route);
    const exponent = Math.min(10, health.consecutiveFailures);
    health.consecutiveFailures++;
    const delay = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * 2 ** exponent,
    );
    health.cooldownUntil = Math.max(health.cooldownUntil, this.now() + delay);
    this.onEvent?.({
      type: "cooldown",
      routeId: route.id,
      outcome,
      durationMs: delay,
    });
    if (route.kind === "proxy") {
      const index = this.routes.findIndex(
        (candidate) => candidate.id === route.id,
      );
      if (index >= 0) this.cursor = (index + 1) % this.routes.length;
    }
  }

  private shortestCooldown(): number {
    const now = this.now();
    const remaining = [...this.routes, directRoute]
      .map((route) => Math.max(0, this.healthFor(route).cooldownUntil - now))
      .filter((value) => value > 0);
    return remaining.length > 0 ? Math.min(...remaining) : 0;
  }

  private withLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.operationTail.catch(() => {}).then(operation);
    this.operationTail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
