import { expect, test } from "vitest";
import {
  buildCatalog,
  INTEGRATE_MODELS_URL,
  parseGalleryCandidates,
  resolveModelRoute,
  slugCandidates,
} from "../src/catalog.ts";

const LANDING_HTML =
  "<html><head><title>NVIDIA NIM | Try NVIDIA NIM APIs</title></head></html>";

function pageHTML(opts: {
  functionId?: string;
  input?: string[];
  output?: string[];
}): string {
  const fn = opts.functionId ?? "fn";
  const field = (k: string, vals: string[]) =>
    `,\\"${k}\\":[${vals.map((v) => `\\"${v}\\"`).join(",")}]`;
  let inner = `\\"namespace\\":\\"qc69jvmznzxy\\",\\"nvcfFunctionId\\":\\"${fn}\\"`;
  if (opts.input) inner += field("inputModalities", opts.input);
  if (opts.output) inner += field("outputModalities", opts.output);
  return `<html><script type="application/json">{${inner}}</script></html>`;
}

test("slugCandidates tries the bare name then dots->underscores (deduped)", () => {
  expect(slugCandidates("z-ai/glm-5.2")).toEqual(["glm-5.2", "glm-5_2"]);
  expect(slugCandidates("meta/llama-3.1-8b-instruct")).toEqual([
    "llama-3.1-8b-instruct",
    "llama-3_1-8b-instruct",
  ]);
  // dotless ids dedupe to a single candidate.
  expect(slugCandidates("google/gemma-3-12b-it")).toEqual(["gemma-3-12b-it"]);
});

test("buildCatalog keeps page Text-in/Text-out models and drops the rest", async () => {
  const seen: string[] = [];
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
              id: "meta/llama-3.1-8b-instruct",
              object: "model",
              created: 2,
              owned_by: "meta",
            },
            {
              id: "baai/bge-m3",
              object: "model",
              created: 3,
              owned_by: "baai",
            },
            {
              id: "minimaxai/minimax-m3",
              object: "model",
              created: 4,
              owned_by: "minimaxai",
            },
            {
              id: "nvidia/cosmos-reason2-8b",
              object: "model",
              created: 5,
              owned_by: "nvidia",
            },
            {
              id: "google/gemma-3-12b-it",
              object: "model",
              created: 6,
              owned_by: "google",
            },
            {
              id: "adept/fuyu-8b",
              object: "model",
              created: 7,
              owned_by: "adept",
            },
          ],
        }),
        { status: 200 },
      );
    }
    if (u === "https://build.nvidia.com/z-ai/glm-5.2")
      return new Response(
        pageHTML({ functionId: "glm-fn", input: ["Text"], output: ["Text"] }),
        { status: 200 },
      );
    if (u === "https://build.nvidia.com/meta/llama-3_1-8b-instruct")
      // underscored slug returns the real page, bare dots slug lands on the generic page
      return new Response(
        pageHTML({ functionId: "llama-fn", input: ["Text"], output: ["Text"] }),
        { status: 200 },
      );
    if (u === "https://build.nvidia.com/baai/bge-m3")
      // deployed but no modalities field -> excluded
      return new Response(pageHTML({ functionId: "bge-fn" }), { status: 200 });
    if (u === "https://build.nvidia.com/minimaxai/minimax-m3")
      // multimodal input, Text output -> included
      return new Response(
        pageHTML({
          functionId: "mm-fn",
          input: ["Text", "Image", "Video"],
          output: ["Text"],
        }),
        { status: 200 },
      );
    if (u === "https://build.nvidia.com/adept/fuyu-8b")
      // Text/Image in, Text out, but "None" sentinel -> undeployed, excluded
      return new Response(
        pageHTML({
          functionId: "None",
          input: ["Text", "Image"],
          output: ["Text"],
        }),
        { status: 200 },
      );
    if (u === "https://build.nvidia.com/nvidia/cosmos-reason2-8b")
      // stale integrate id -> 308 rename -> skipped
      return new Response("", {
        status: 308,
        headers: {
          location: "https://build.nvidia.com/nvidia/cosmos3-nano-reasoner",
        },
      });
    seen.push(u);
    return new Response(LANDING_HTML, { status: 200 });
  };

  const result = await buildCatalog({ fetchImpl, concurrency: 2 });
  expect(result.entries).toEqual([
    {
      id: "meta/llama-3.1-8b-instruct",
      slug: "llama-3_1-8b-instruct",
      namespace: "qc69jvmznzxy",
      functionId: "llama-fn",
      created: 2,
      ownedBy: "meta",
    },
    {
      id: "minimaxai/minimax-m3",
      slug: "minimax-m3",
      namespace: "qc69jvmznzxy",
      functionId: "mm-fn",
      created: 4,
      ownedBy: "minimaxai",
    },
    {
      id: "z-ai/glm-5.2",
      slug: "glm-5.2",
      namespace: "qc69jvmznzxy",
      functionId: "glm-fn",
      created: 1,
      ownedBy: "z-ai",
    },
  ]);
  expect(result.refreshMs).toBe(6 * 60 * 60 * 1000);
  // dotless, no real page -> strict page-only drops it
  expect(seen).toContain("https://build.nvidia.com/google/gemma-3-12b-it");
  // nvcfFunctionId "None" (undeployed sentinel) -> dropped
  expect(result.entries.find((e) => e.id === "adept/fuyu-8b")).toBeUndefined();
});

test("buildCatalog propagates integrate-list failure", async () => {
  const fetchImpl = async () => new Response("boom", { status: 502 });
  await expect(buildCatalog({ fetchImpl })).rejects.toThrow(
    /integrate model list 502/,
  );
});

test("buildCatalog trusts the gallery chat label and skips the per-page modality check", async () => {
  // A chat-labeled page omitting modality arrays is kept via the gallery label.
  const fetchImpl = async (url: string | URL) => {
    if (String(url) === "https://build.nvidia.com/thinkingmachines/inkling")
      return new Response(pageHTML({ functionId: "ink-fn" }), { status: 200 });
    return new Response(LANDING_HTML, { status: 200 });
  };
  const result = await buildCatalog({
    fetchImpl,
    galleryCandidates: [
      {
        id: "thinkingmachines/inkling",
        created: 0,
        ownedBy: "thinkingmachines",
      },
    ],
  });
  expect(result.entries).toEqual([
    {
      id: "thinkingmachines/inkling",
      slug: "inkling",
      namespace: "qc69jvmznzxy",
      functionId: "ink-fn",
      created: 0,
      ownedBy: "thinkingmachines",
    },
  ]);
  expect(result.refreshMs).toBe(6 * 60 * 60 * 1000);
});

test("resolveModelRoute reads namespace + functionId from the model page", async () => {
  const fetchImpl = async (url: string | URL) => {
    if (String(url) === "https://build.nvidia.com/z-ai/glm-5.2")
      return new Response(
        pageHTML({ functionId: "glm-fn", input: ["Text"], output: ["Text"] }),
        { status: 200 },
      );
    return new Response(LANDING_HTML, { status: 200 });
  };
  expect(await resolveModelRoute("z-ai/glm-5.2", fetchImpl)).toEqual({
    modelId: "qc69jvmznzxy/glm-5.2",
    functionId: "glm-fn",
  });
});

test("resolveModelRoute falls back to the underscore slug when the bare page lands", async () => {
  const calls: string[] = [];
  const fetchImpl = async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u === "https://build.nvidia.com/meta/llama-3_1-8b-instruct")
      return new Response(
        pageHTML({ functionId: "llama-fn", input: ["Text"], output: ["Text"] }),
        { status: 200 },
      );
    return new Response(LANDING_HTML, { status: 200 });
  };
  expect(
    await resolveModelRoute("meta/llama-3.1-8b-instruct", fetchImpl),
  ).toEqual({
    modelId: "qc69jvmznzxy/llama-3_1-8b-instruct",
    functionId: "llama-fn",
  });
  expect(calls).toContain(
    "https://build.nvidia.com/meta/llama-3.1-8b-instruct",
  );
  expect(calls).toContain(
    "https://build.nvidia.com/meta/llama-3_1-8b-instruct",
  );
});

test("resolveModelRoute returns null when no candidate is a real model page", async () => {
  const fetchImpl = async () => new Response(LANDING_HTML, { status: 200 });
  expect(
    await resolveModelRoute("google/gemma-3-12b-it", fetchImpl),
  ).toBeNull();
});

// Mirrors the escaped JSON shape the gallery RSC payload embeds.
function galleryBlob(o: {
  rid: string;
  chat?: boolean; // default true
  free?: boolean; // default true
  publisher?: string; // omit to drop (no publisher label)
  deprecation?: string; // MM/DD/YYYY
  dateCreated?: string; // ISO
}): string {
  const lbl = (k: string, vs: string[]) =>
    `{\\"key\\":\\"${k}\\",\\"values\\":[${vs.map((v) => `\\"${v}\\"`).join(",")}]}`;
  const att = (k: string, v: string) =>
    `{\\"key\\":\\"${k}\\",\\"value\\":\\"${v}\\"}`;
  const labels = [
    lbl("playgroundType", [o.chat === false ? "embedding" : "chat"]),
    lbl("nimType", [o.free === false ? "Partner Endpoint" : "Free Endpoint"]),
    ...(o.publisher ? [lbl("publisher", [o.publisher])] : []),
  ];
  const attrs = o.deprecation ? [att("DEPRECATION", o.deprecation)] : [];
  const parts = [
    `\\"resourceType\\":\\"ENDPOINT\\"`,
    `\\"resourceId\\":\\"${o.rid}\\"`,
    `\\"labels\\":[${labels.join(",")}]`,
    ...(attrs.length ? [`\\"attributes\\":[${attrs.join(",")}]`] : []),
    ...(o.dateCreated ? [`\\"dateCreated\\":\\"${o.dateCreated}\\"`] : []),
  ];
  return `{${parts.join(",")}}`;
}

test("parseGalleryCandidates keeps free+chat non-deprecated models and drops the rest", () => {
  const html = `<html><script>self.__next_f.push([1,"${[
    galleryBlob({
      rid: "qc69jvmznzxy/glm-5.2",
      publisher: "z-ai",
      deprecation: "12/31/2099",
      dateCreated: "2026-07-03T20:32:17.807Z",
    }),
    galleryBlob({
      rid: "qc69jvmznzxy/minimax-m3",
      publisher: "minimaxai",
      dateCreated: "2026-06-12T14:01:30.878Z",
    }),
    galleryBlob({
      rid: "qc69jvmznzxy/old-thing",
      publisher: "nvidia",
      deprecation: "01/01/2000",
      dateCreated: "2020-01-01T00:00:00Z",
    }),
    galleryBlob({
      rid: "qc69jvmznzxy/not-chat",
      chat: false,
      publisher: "nvidia",
    }),
    galleryBlob({
      rid: "qc69jvmznzxy/not-free",
      free: false,
      publisher: "nvidia",
    }),
    galleryBlob({ rid: "qc69jvmznzxy/no-pub" }),
    galleryBlob({
      rid: "qc69jvmznzxy/glm-5.2",
      publisher: "z-ai",
      dateCreated: "2026-07-03T20:32:17.807Z",
    }),
  ].join("")}"])</script></html>`;
  const cands = parseGalleryCandidates(html);
  expect(cands.map((c) => c.id).sort()).toEqual([
    "minimaxai/minimax-m3",
    "z-ai/glm-5.2",
  ]);
  const glm = cands.find((c) => c.id === "z-ai/glm-5.2");
  expect(glm?.ownedBy).toBe("z-ai");
  expect(glm?.created).toBe(
    Math.floor(Date.parse("2026-07-03T20:32:17.807Z") / 1000),
  );
});
