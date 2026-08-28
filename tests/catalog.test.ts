import { expect, test } from "vitest";
import {
  buildCatalog,
  endpointCandidates,
  ENDPOINTS_URL,
  resolveModelRoute,
  slugCandidates,
} from "../src/catalog.ts";

function artifact(o: {
  name: string;
  orgName?: string;
  publisher?: string;
  labels?: string[];
  createdDate?: string;
}) {
  return {
    name: o.name,
    orgName: o.orgName ?? "test-namespace",
    ...(o.publisher ? { publisher: o.publisher } : {}),
    labels: o.labels ?? ["chat", "Free Endpoint"],
    ...(o.createdDate ? { createdDate: o.createdDate } : {}),
  };
}

const SPEC_BASE = "https://api.ngc.nvidia.com/v2/endpoints";

test("slugCandidates tries the bare name then dots->underscores (deduped)", () => {
  expect(slugCandidates("publisher2/model-1.0")).toEqual(["model-1.0", "model-1_0"]);
  expect(slugCandidates("publisher1/model-3.1")).toEqual([
    "model-3.1",
    "model-3_1",
  ]);
  // dotless ids dedupe to a single candidate.
  expect(slugCandidates("publisher1/model2")).toEqual(["model2"]);
});

test("endpointCandidates keeps free chat models and drops the rest", () => {
  const json = {
    artifacts: [
      artifact({
        name: "model-1.0",
        publisher: "publisher2",
        createdDate: "2026-06-07T04:20:00.069Z",
      }),
      artifact({
        name: "not-chat",
        publisher: "publisher1",
        labels: ["Free Endpoint"],
      }),
      artifact({ name: "not-free", publisher: "publisher1", labels: ["chat"] }),
      artifact({ name: "no-publisher", labels: ["chat", "Free Endpoint"] }),
      artifact({
        name: "CHAT-case",
        publisher: "publisher1",
        labels: ["Chat", "Free Endpoint"],
      }),
      // duplicate id collapses to the first occurrence
      artifact({ name: "model-1.0", publisher: "publisher2" }),
    ],
  };
  const cands = endpointCandidates(json);
  expect(cands.map((c) => c.id).sort()).toEqual([
    "publisher1/CHAT-case",
    "publisher2/model-1.0",
  ]);
  const m = cands.find((c) => c.id === "publisher2/model-1.0");
  expect(m?.ownedBy).toBe("publisher2");
  expect(m?.created).toBe(
    Math.floor(Date.parse("2026-06-07T04:20:00.069Z") / 1000),
  );
});

test("buildCatalog keeps models with a deployment spec and drops the rest", async () => {
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    if (u === ENDPOINTS_URL) {
      return new Response(
        JSON.stringify({
          artifacts: [
            artifact({
              name: "model-1.0",
              publisher: "publisher2",
              createdDate: "2026-06-07T04:20:00.069Z",
            }),
            artifact({ name: "model1", publisher: "publisher1" }),
            artifact({ name: "undeployed", publisher: "publisher1" }),
            artifact({ name: "missing", publisher: "publisher1" }),
          ],
        }),
        { status: 200 },
      );
    }
    if (u === `${SPEC_BASE}/test-namespace/model-1.0/spec`)
      return new Response(
        JSON.stringify({
          namespace: "test-namespace",
          nvcfFunctionId: "model-1-fn",
        }),
        { status: 200 },
      );
    if (u === `${SPEC_BASE}/test-namespace/model1/spec`)
      return new Response(
        JSON.stringify({
          namespace: "test-namespace",
          nvcfFunctionId: "model1-fn",
        }),
        { status: 200 },
      );
    if (u === `${SPEC_BASE}/test-namespace/undeployed/spec`)
      // spec without nvcfFunctionId -> undeployed, dropped
      return new Response(JSON.stringify({ namespace: "test-namespace" }), {
        status: 200,
      });
    return new Response("not found", { status: 404 });
  };

  const result = await buildCatalog({ fetchImpl, concurrency: 2 });
  expect(result.entries).toEqual([
    {
      id: "publisher1/model1",
      slug: "model1",
      namespace: "test-namespace",
      functionId: "model1-fn",
      created: 0,
      ownedBy: "publisher1",
    },
    {
      id: "publisher2/model-1.0",
      slug: "model-1.0",
      namespace: "test-namespace",
      functionId: "model-1-fn",
      created: Math.floor(Date.parse("2026-06-07T04:20:00.069Z") / 1000),
      ownedBy: "publisher2",
    },
  ]);
});

test("buildCatalog propagates endpoints-list failure", async () => {
  const fetchImpl = async () => new Response("boom", { status: 502 });
  await expect(buildCatalog({ fetchImpl })).rejects.toThrow(
    /endpoints list 502/,
  );
});

test("resolveModelRoute matches the endpoint by name and reads its spec", async () => {
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    if (u === ENDPOINTS_URL)
      return new Response(
        JSON.stringify({
          artifacts: [artifact({ name: "model-1.0", publisher: "publisher2" })],
        }),
        { status: 200 },
      );
    if (u === `${SPEC_BASE}/test-namespace/model-1.0/spec`)
      return new Response(
        JSON.stringify({
          namespace: "test-namespace",
          nvcfFunctionId: "model-1-fn",
        }),
        { status: 200 },
      );
    return new Response("not found", { status: 404 });
  };
  expect(await resolveModelRoute("publisher2/model-1.0", fetchImpl)).toEqual({
    modelId: "test-namespace/model-1.0",
    functionId: "model-1-fn",
  });
});

test("resolveModelRoute matches the underscored endpoint name", async () => {
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    if (u === ENDPOINTS_URL)
      return new Response(
        JSON.stringify({
          artifacts: [
            artifact({ name: "model-3_1", publisher: "publisher1" }),
          ],
        }),
        { status: 200 },
      );
    if (u === `${SPEC_BASE}/test-namespace/model-3_1/spec`)
      return new Response(
        JSON.stringify({
          namespace: "test-namespace",
          nvcfFunctionId: "model-fn",
        }),
        { status: 200 },
      );
    return new Response("not found", { status: 404 });
  };
  expect(
    await resolveModelRoute("publisher1/model-3.1", fetchImpl),
  ).toEqual({
    modelId: "test-namespace/model-3_1",
    functionId: "model-fn",
  });
});

test("resolveModelRoute returns null when no endpoint name matches", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
  expect(
    await resolveModelRoute("publisher1/model2", fetchImpl),
  ).toBeNull();
});
