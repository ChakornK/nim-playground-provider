import type { ProxyDefinition } from "./proxy-list.ts";

export type FetchLike = (
  input: string | URL | Request,
  init?: BunFetchRequestInit,
) => Promise<Response>;

export interface RouteFetchTransport {
  routeId: string;
  fetch: FetchLike;
  close(): Promise<void>;
}

export class UnsupportedProxyTargetError extends Error {
  constructor() {
    super("proxy mode only permits HTTPS targets");
    this.name = "UnsupportedProxyTargetError";
  }
}

export class RouteTransportError extends Error {
  constructor(cause?: unknown) {
    super("egress route transport failed", { cause });
    this.name = "RouteTransportError";
  }
}

const targetUrl = (input: string | URL | Request): URL => {
  if (input instanceof Request) return new URL(input.url);
  return new URL(String(input));
};

export function createRouteFetchTransport(opts: {
  route?: ProxyDefinition;
  socksAdapterUrl?: string;
  fetchImpl?: FetchLike;
  close?: () => Promise<void>;
}): RouteFetchTransport {
  const route = opts.route;
  const fetchImpl = opts.fetchImpl ?? (fetch as FetchLike);
  const proxyUrl =
    route?.scheme === "http" ? route.canonicalUrl : opts.socksAdapterUrl;
  if (route && route.scheme !== "http" && !proxyUrl) {
    throw new Error("SOCKS route requires a local adapter");
  }

  const routeFetch: FetchLike = async (input, init) => {
    if (route && targetUrl(input).protocol !== "https:") {
      throw new UnsupportedProxyTargetError();
    }
    try {
      return await fetchImpl(
        input,
        proxyUrl ? { ...init, proxy: proxyUrl } : init,
      );
    } catch (error) {
      if (
        error instanceof UnsupportedProxyTargetError ||
        (error instanceof Error && error.name === "AbortError")
      ) {
        throw error;
      }
      throw new RouteTransportError(error);
    }
  };

  let closed = false;
  return {
    routeId: route?.id ?? "direct",
    fetch: routeFetch,
    close: async () => {
      if (closed) return;
      closed = true;
      await opts.close?.();
    },
  };
}
