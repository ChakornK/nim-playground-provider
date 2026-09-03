import { expect, test } from "bun:test";
import type { ProxyDefinition } from "../src/proxy-list.ts";
import {
  createRouteFetchTransport,
  type FetchLike,
  RouteTransportError,
  UnsupportedProxyTargetError,
} from "../src/route-fetch.ts";

const route = (
  scheme: ProxyDefinition["scheme"],
  canonicalUrl: string,
): ProxyDefinition => ({
  id: `${scheme}-route`,
  scheme,
  host: "204.13.164.127",
  port: 3128,
  canonicalUrl,
});

test("direct transport leaves Bun proxy unset", async () => {
  let init: BunFetchRequestInit | undefined;
  const transport = createRouteFetchTransport({
    fetchImpl: (async (_input, value) => {
      init = value;
      return new Response("ok");
    }) as FetchLike,
  });

  expect((await transport.fetch("https://example.com")).status).toBe(200);
  expect(init?.proxy).toBeUndefined();
  expect(transport.routeId).toBe("direct");
});

test("HTTP transport passes its canonical URL to Bun fetch", async () => {
  let proxy: BunFetchRequestInit["proxy"];
  const definition = route("http", "http://204.13.164.127:3128");
  const transport = createRouteFetchTransport({
    route: definition,
    fetchImpl: (async (_input, init) => {
      proxy = init?.proxy;
      return new Response("ok");
    }) as FetchLike,
  });

  await transport.fetch("https://api.ngc.nvidia.com/test");
  expect(proxy).toBe(definition.canonicalUrl);
  expect(transport.routeId).toBe(definition.id);
});

test("SOCKS transport passes the loopback adapter to Bun fetch", async () => {
  let proxy: BunFetchRequestInit["proxy"];
  const transport = createRouteFetchTransport({
    route: route("socks5", "socks5://204.13.164.127:3128"),
    socksAdapterUrl: "http://127.0.0.1:45678",
    fetchImpl: (async (_input, init) => {
      proxy = init?.proxy;
      return new Response("ok");
    }) as FetchLike,
  });

  await transport.fetch("https://api.hcaptcha.com/test");
  expect(proxy).toBe("http://127.0.0.1:45678");
});

test("proxy transport rejects non-HTTPS targets before fetch", async () => {
  let calls = 0;
  const transport = createRouteFetchTransport({
    route: route("http", "http://204.13.164.127:3128"),
    fetchImpl: (async () => {
      calls++;
      return new Response("unexpected");
    }) as FetchLike,
  });

  await expect(transport.fetch("http://example.com")).rejects.toBeInstanceOf(
    UnsupportedProxyTargetError,
  );
  expect(calls).toBe(0);
});

test("transport preserves aborts and sanitizes other fetch errors", async () => {
  const aborted = createRouteFetchTransport({
    fetchImpl: (async () => {
      throw new DOMException("aborted", "AbortError");
    }) as FetchLike,
  });
  await expect(aborted.fetch("https://example.com")).rejects.toMatchObject({
    name: "AbortError",
  });

  const failed = createRouteFetchTransport({
    fetchImpl: (async () => {
      throw new Error("http://secret-proxy.example:9999 failed");
    }) as FetchLike,
  });
  try {
    await failed.fetch("https://example.com");
    throw new Error("expected fetch to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(RouteTransportError);
    expect((error as Error).message).not.toContain("secret-proxy");
  }
});

test("transport close runs once", async () => {
  let closes = 0;
  const transport = createRouteFetchTransport({
    close: async () => {
      closes++;
    },
  });
  await transport.close();
  await transport.close();
  expect(closes).toBe(1);
});
