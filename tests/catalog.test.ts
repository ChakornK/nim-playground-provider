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
    orgName: o.orgName ?? "qc69jvmznzxy",
    ...(o.publisher ? { publisher: o.publisher } : {}),
    labels: o.labels ?? ["chat", "Free Endpoint"],
    ...(o.createdDate ? { createdDate: o.createdDate } : {}),
  };
}

const SPEC_BASE = "https://api.ngc.nvidia.com/v2/endpoints";

test("slugCandidates tries the bare name then dots->underscores (deduped)", () => {
  expect(slugCandidates("z-ai/glm-5.2")).toEqual(["glm-5.2", "glm-5_2"]);
  expect(slugCandidates("meta/llama-3.1-8b-instruct")).toEqual([
    "llama-3.1-8b-instruct",
    "llama-3_1-8b-instruct",
  ]);
  // dotless ids dedupe to a single candidate.
  expect(slugCandidates("google/gemma-3-12b-it")).toEqual(["gemma-3-12b-it"]);
});

test("endpointCandidates keeps free chat models and drops the rest", () => {
  const json = {
    artifacts: [
      artifact({
        name: "glm-5.2",
        publisher: "z-ai",
        createdDate: "2026-07-03T20:32:17.807Z",
      }),
      artifact({
        name: "not-chat",
        publisher: "nvidia",
        labels: ["Free Endpoint"],
      }),
      artifact({ name: "not-free", publisher: "nvidia", labels: ["chat"] }),
      artifact({ name: "no-publisher", labels: ["chat", "Free Endpoint"] }),
      artifact({
        name: "CHAT-case",
        publisher: "nvidia",
        labels: ["Chat", "Free Endpoint"],
      }),
      // duplicate id collapses to the first occurrence
      artifact({ name: "glm-5.2", publisher: "z-ai" }),
    ],
  };
  const cands = endpointCandidates(json);
  expect(cands.map((c) => c.id).sort()).toEqual([
    "nvidia/CHAT-case",
    "z-ai/glm-5.2",
  ]);
  const glm = cands.find((c) => c.id === "z-ai/glm-5.2");
  expect(glm?.ownedBy).toBe("z-ai");
  expect(glm?.created).toBe(
    Math.floor(Date.parse("2026-07-03T20:32:17.807Z") / 1000),
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
              name: "glm-5.2",
              publisher: "z-ai",
              createdDate: "2026-07-03T20:32:17.807Z",
            }),
            artifact({ name: "minimax-m3", publisher: "minimaxai" }),
            artifact({ name: "undeployed", publisher: "nvidia" }),
            artifact({ name: "missing", publisher: "nvidia" }),
          ],
        }),
        { status: 200 },
      );
    }
    if (u === `${SPEC_BASE}/qc69jvmznzxy/glm-5.2/spec`)
      return new Response(
        JSON.stringify({
          namespace: "qc69jvmznzxy",
          nvcfFunctionId: "glm-fn",
        }),
        { status: 200 },
      );
    if (u === `${SPEC_BASE}/qc69jvmznzxy/minimax-m3/spec`)
      return new Response(
        JSON.stringify({
          namespace: "qc69jvmznzxy",
          nvcfFunctionId: "mm-fn",
        }),
        { status: 200 },
      );
    if (u === `${SPEC_BASE}/qc69jvmznzxy/undeployed/spec`)
      // spec without nvcfFunctionId -> undeployed, dropped
      return new Response(JSON.stringify({ namespace: "qc69jvmznzxy" }), {
        status: 200,
      });
    return new Response("not found", { status: 404 });
  };

  const result = await buildCatalog({ fetchImpl, concurrency: 2 });
  expect(result.entries).toEqual([
    {
      id: "minimaxai/minimax-m3",
      slug: "minimax-m3",
      namespace: "qc69jvmznzxy",
      functionId: "mm-fn",
      created: 0,
      ownedBy: "minimaxai",
    },
    {
      id: "z-ai/glm-5.2",
      slug: "glm-5.2",
      namespace: "qc69jvmznzxy",
      functionId: "glm-fn",
      created: Math.floor(Date.parse("2026-07-03T20:32:17.807Z") / 1000),
      ownedBy: "z-ai",
    },
  ]);
  expect(result.refreshMs).toBe(6 * 60 * 60 * 1000);
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
          artifacts: [artifact({ name: "glm-5.2", publisher: "z-ai" })],
        }),
        { status: 200 },
      );
    if (u === `${SPEC_BASE}/qc69jvmznzxy/glm-5.2/spec`)
      return new Response(
        JSON.stringify({
          namespace: "qc69jvmznzxy",
          nvcfFunctionId: "glm-fn",
        }),
        { status: 200 },
      );
    return new Response("not found", { status: 404 });
  };
  expect(await resolveModelRoute("z-ai/glm-5.2", fetchImpl)).toEqual({
    modelId: "qc69jvmznzxy/glm-5.2",
    functionId: "glm-fn",
  });
});

test("resolveModelRoute matches the underscored endpoint name", async () => {
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    if (u === ENDPOINTS_URL)
      return new Response(
        JSON.stringify({
          artifacts: [
            artifact({ name: "llama-3_1-8b-instruct", publisher: "meta" }),
          ],
        }),
        { status: 200 },
      );
    if (u === `${SPEC_BASE}/qc69jvmznzxy/llama-3_1-8b-instruct/spec`)
      return new Response(
        JSON.stringify({
          namespace: "qc69jvmznzxy",
          nvcfFunctionId: "llama-fn",
        }),
        { status: 200 },
      );
    return new Response("not found", { status: 404 });
  };
  expect(
    await resolveModelRoute("meta/llama-3.1-8b-instruct", fetchImpl),
  ).toEqual({
    modelId: "qc69jvmznzxy/llama-3_1-8b-instruct",
    functionId: "llama-fn",
  });
});

test("resolveModelRoute returns null when no endpoint name matches", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ artifacts: [] }), { status: 200 });
  expect(
    await resolveModelRoute("google/gemma-3-12b-it", fetchImpl),
  ).toBeNull();
});
