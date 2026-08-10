import { expect, test } from "bun:test";
import {
  buildCatalog,
  INTEGRATE_MODELS_URL,
  isTextCapable,
  slugCandidates,
} from "../src/catalog";

test("isTextCapable keeps LLMs and vision-language, drops non-text", () => {
  expect(isTextCapable("z-ai/glm-5.2")).toBe(true);
  expect(isTextCapable("thinkingmachines/inkling")).toBe(true);
  expect(isTextCapable("meta/llama-3.2-11b-vision-instruct")).toBe(true);
  expect(isTextCapable("nvidia/cosmos-reason2-8b")).toBe(true);
  expect(isTextCapable("nvidia/nemotron-nano-12b-v2-vl")).toBe(true);
  expect(isTextCapable("baai/bge-m3")).toBe(false);
  expect(isTextCapable("nvidia/nv-embed-v1")).toBe(false);
  expect(isTextCapable("nvidia/nvclip")).toBe(false);
  expect(isTextCapable("nvidia/riva-translate-4b-instruct-v2")).toBe(false);
  expect(isTextCapable("nvidia/nemoretriever-parse")).toBe(false);
  expect(isTextCapable("meta/llama-guard-4-12b")).toBe(false);
});

test("slugCandidates tries the bare name then dots->underscores", () => {
  expect(slugCandidates("z-ai/glm-5.2")).toEqual(["glm-5.2", "glm-5_2"]);
  expect(slugCandidates("meta/llama-3.1-8b-instruct")).toEqual([
    "llama-3.1-8b-instruct",
    "llama-3_1-8b-instruct",
  ]);
});

test("buildCatalog uses the queue functionId and filters non-text", async () => {
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    if (u === INTEGRATE_MODELS_URL) {
      return new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "z-ai/glm-5.2",
              object: "model",
              created: 1,
              owned_by: "z-ai",
            },
            {
              id: "baai/bge-m3",
              object: "model",
              created: 2,
              owned_by: "baai",
            },
            {
              id: "nope/not-found",
              object: "model",
              created: 3,
              owned_by: "nope",
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (u.endsWith("/queues/models/qc69jvmznzxy/glm-5.2")) {
      return new Response(JSON.stringify({ functionId: "glm-fn" }), {
        status: 200,
      });
    }
    if (u.endsWith("/queues/models/qc69jvmznzxy/glm-5_2")) {
      return new Response("not found", { status: 404 });
    }
    if (u.endsWith("/queues/models/qc69jvmznzxy/bge-m3")) {
      return new Response(JSON.stringify({ functionId: "bge-fn" }), {
        status: 200,
      });
    }
    return new Response("not found", { status: 404 });
  };

  const catalog = await buildCatalog({
    fetchImpl: fetchImpl as typeof fetch,
    concurrency: 2,
  });
  expect(catalog).toEqual([
    {
      id: "z-ai/glm-5.2",
      slug: "glm-5.2",
      functionId: "glm-fn",
      created: 1,
      ownedBy: "z-ai",
    },
  ]);
});

test("buildCatalog propagates integrate-list failure", async () => {
  const fetchImpl = async () => new Response("boom", { status: 502 });
  await expect(buildCatalog({ fetchImpl })).rejects.toThrow(
    /integrate model list 502/,
  );
});
