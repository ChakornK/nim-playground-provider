import { expect, test } from "bun:test";
import type { UpstreamChatParams } from "../src/types.ts";
import {
  readJsonBody,
  Upstream,
  UpstreamBodyTimeoutError,
  UpstreamHeadersTimeoutError,
} from "../src/upstream.ts";

const params = (signal?: AbortSignal): UpstreamChatParams => ({
  token: "P1_test",
  messages: [{ role: "user", content: "hi" }],
  model: "moonshotai/kimi-k3",
  route: { modelId: "namespace/kimi-k3", functionId: "function-id" },
  enableThinking: false,
  stream: false,
  signal,
});

const abortableFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const signal = init?.signal;
    const rejectAbort = () =>
      reject(new DOMException("This operation was aborted", "AbortError"));
    if (signal?.aborted) rejectAbort();
    else signal?.addEventListener("abort", rejectAbort, { once: true });
  })) as typeof fetch;

test("upstream marks dispatch synchronously before calling fetch", async () => {
  const events: string[] = [];
  const upstream = new Upstream({
    fetchImpl: async (_input, init) => {
      events.push("fetch");
      expect(init?.redirect).toBe("manual");
      return new Response("{}");
    },
  });
  const request = params();
  request.onDispatch = () => events.push("dispatch");

  await upstream.chat(request);
  expect(events).toEqual(["dispatch", "fetch"]);
});

test("upstream marks timed-out fetches as potentially dispatched", async () => {
  let dispatched = false;
  const upstream = new Upstream({
    headersTimeoutMs: 10,
    fetchImpl: abortableFetch,
  });
  const request = params();
  request.onDispatch = () => {
    dispatched = true;
  };

  await expect(upstream.chat(request)).rejects.toBeInstanceOf(
    UpstreamHeadersTimeoutError,
  );
  expect(dispatched).toBe(true);
});

test("upstream reports its own headers timeout distinctly", async () => {
  const upstream = new Upstream({
    headersTimeoutMs: 10,
    fetchImpl: abortableFetch,
  });

  await expect(upstream.chat(params())).rejects.toBeInstanceOf(
    UpstreamHeadersTimeoutError,
  );
});

test("downstream cancellation remains an AbortError", async () => {
  const controller = new AbortController();
  const upstream = new Upstream({
    headersTimeoutMs: 1_000,
    fetchImpl: abortableFetch,
  });
  const request = upstream.chat(params(controller.signal));
  controller.abort();

  await expect(request).rejects.toMatchObject({ name: "AbortError" });
});

test("non-stream body timeout cancels the upstream reader", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
        return new Promise<void>(() => {});
      },
    }),
  );

  await expect(
    readJsonBody(response, { timeoutMs: 10 }),
  ).rejects.toBeInstanceOf(UpstreamBodyTimeoutError);
  expect(cancelled).toBe(true);
});

test("downstream abort cancels a non-stream body reader", async () => {
  let cancelled = false;
  const controller = new AbortController();
  const response = new Response(
    new ReadableStream<Uint8Array>({
      cancel() {
        cancelled = true;
      },
    }),
  );
  const reading = readJsonBody(response, {
    timeoutMs: 1_000,
    signal: controller.signal,
  });
  controller.abort();

  await expect(reading).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled).toBe(true);
});
