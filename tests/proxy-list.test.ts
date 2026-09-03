import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertProxyModeConcurrency,
  formatProxyList,
  isGlobalProxyAddress,
  loadProxyFile,
  MAX_PROXY_FILE_BYTES,
  MAX_PROXY_FILE_LINES,
  parseProxyList,
} from "../src/proxy-list.ts";

test("parser accepts canonical unauthenticated HTTP and SOCKS IP URLs", () => {
  const parsed = parseProxyList(
    [
      "http://204.13.164.127:3128",
      "socks4://1.1.1.1:1080",
      "socks5://[2606:4700:4700::1111]:9050",
    ].join("\n"),
  );

  expect(parsed.rejectedLines).toEqual([]);
  expect(parsed.routes.map((route) => route.canonicalUrl)).toEqual([
    "http://204.13.164.127:3128",
    "socks4://1.1.1.1:1080",
    "socks5://[2606:4700:4700::1111]:9050",
  ]);
  expect(new Set(parsed.routes.map((route) => route.id)).size).toBe(3);
});

test("parser ignores comments and keeps the first canonical duplicate", () => {
  const parsed = parseProxyList(`
    # local proxy list
    HTTP://204.13.164.127:3128
    http://204.13.164.127:3128

    socks5://43.164.136.189:1080
  `);

  expect(parsed.routes.map((route) => route.canonicalUrl)).toEqual([
    "http://204.13.164.127:3128",
    "socks5://43.164.136.189:1080",
  ]);
  expect(parsed.rejectedLines).toEqual([]);
});

test("parser rejects unsafe or malformed lines without echoing input", () => {
  const secret = "do-not-log-this";
  const parsed = parseProxyList(
    [
      `http://${secret}@204.13.164.127:3128`,
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "https://204.13.164.127:3128",
      "http://204.13.164.127:0",
      "http://204.13.164.127:3128/path",
      "http://204.13.164.127:3128?x=1",
      "http://204.13.164.127:3128#x",
    ].join("\n"),
  );

  expect(parsed.routes).toEqual([]);
  expect(parsed.rejectedLines.map((item) => item.reason)).toEqual([
    "credentials_not_allowed",
    "hostname_not_allowed",
    "non_global_address",
    "unsupported_scheme",
    "invalid_port",
    "path_not_allowed",
    "query_not_allowed",
    "fragment_not_allowed",
  ]);
  expect(JSON.stringify(parsed.rejectedLines)).not.toContain(secret);
});

test("global address filter rejects special-purpose ranges", () => {
  for (const address of [
    "0.0.0.1",
    "10.0.0.1",
    "100.64.0.1",
    "127.0.0.1",
    "169.254.1.1",
    "172.16.0.1",
    "192.168.1.1",
    "198.51.100.1",
    "203.0.113.1",
    "::1",
    "fc00::1",
    "fe80::1",
    "2001:db8::1",
  ]) {
    expect(isGlobalProxyAddress(address)).toBe(false);
  }
  expect(isGlobalProxyAddress("1.1.1.1")).toBe(true);
  expect(isGlobalProxyAddress("2606:4700:4700::1111")).toBe(true);
});

test("parser enforces byte and line bounds", () => {
  expect(() => parseProxyList("x".repeat(MAX_PROXY_FILE_BYTES + 1))).toThrow(
    "byte limit",
  );
  expect(() => parseProxyList("#\n".repeat(MAX_PROXY_FILE_LINES + 1))).toThrow(
    "line limit",
  );
});

test("canonical formatter round-trips generated valid proxy lists", () => {
  const schemes = ["http", "socks4", "socks5"] as const;
  const firstOctets = [1, 8, 11, 23, 45, 68, 91, 103, 116, 154, 181, 199, 204];
  for (let seed = 0; seed < 100; seed++) {
    const lines = Array.from({ length: 1 + (seed % 12) }, (_, index) => {
      const first = firstOctets[(seed + index) % firstOctets.length] ?? 8;
      const host = `${first}.${1 + ((seed * 17 + index) % 220)}.${1 + ((seed + index * 7) % 220)}.${1 + ((seed * 3 + index * 11) % 220)}`;
      const scheme = schemes[(seed + index) % schemes.length] ?? "http";
      return `${scheme}://${host}:${1024 + seed * 12 + index}`;
    });
    const first = parseProxyList(lines.concat(lines[0] ?? []).join("\n"));
    const formatted = formatProxyList(first.routes);
    const second = parseProxyList(formatted);
    expect(second.routes).toEqual(first.routes);
    expect(formatProxyList(second.routes)).toBe(formatted);
  }
});

test("proxy mode requires upstream concurrency one", () => {
  const loaded = {
    path: "PROXIES.txt",
    state: "loaded" as const,
    routes: parseProxyList("http://204.13.164.127:3128").routes,
    rejectedLines: [],
  };
  expect(() => assertProxyModeConcurrency(loaded, 2)).toThrow(
    "UPSTREAM_CONCURRENCY must be 1",
  );
  expect(() => assertProxyModeConcurrency(loaded, 1)).not.toThrow();
  expect(() =>
    assertProxyModeConcurrency({ ...loaded, state: "missing", routes: [] }, 8),
  ).not.toThrow();
});

test("file loader distinguishes missing, unusable, and loaded files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-list-test-"));
  try {
    const missing = await loadProxyFile(join(dir, "missing.txt"));
    expect(missing.state).toBe("missing");

    const emptyPath = join(dir, "empty.txt");
    await writeFile(emptyPath, "# comments only\n");
    const empty = await loadProxyFile(emptyPath);
    expect(empty.state).toBe("unusable");
    expect(empty.routes).toEqual([]);

    const invalidUtf8Path = join(dir, "invalid.txt");
    await writeFile(invalidUtf8Path, Buffer.from([0xc3, 0x28]));
    const invalidUtf8 = await loadProxyFile(invalidUtf8Path);
    expect(invalidUtf8.errorCategory).toBe("invalid_utf8");

    const loadedPath = join(dir, "loaded.txt");
    await writeFile(loadedPath, "http://204.13.164.127:3128\n");
    const loaded = await loadProxyFile(loadedPath);
    expect(loaded.state).toBe("loaded");
    expect(loaded.routes).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
