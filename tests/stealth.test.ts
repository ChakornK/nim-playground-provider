import { expect, test } from "bun:test";
import { forwardedResponseHeaders } from "../src/stealth.ts";

test("decoded proxy responses drop stale encoding and framing headers", () => {
  const forwarded = forwardedResponseHeaders(
    new Headers({
      "cache-control": "public, max-age=60",
      connection: "keep-alive",
      "content-encoding": "br",
      "content-length": "123",
      "content-type": "application/javascript",
      "transfer-encoding": "chunked",
    }),
  );

  expect(forwarded).toEqual({
    "cache-control": "public, max-age=60",
    "content-type": "application/javascript",
  });
});
