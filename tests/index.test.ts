import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("proxy mode rejects concurrency before browser or network startup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "proxy-index-test-"));
  try {
    const proxyFile = join(dir, "PROXIES.txt");
    await writeFile(proxyFile, "http://204.13.164.127:3128\n");
    const child = Bun.spawn([process.execPath, "run", "src/index.ts"], {
      cwd: join(import.meta.dir, ".."),
      env: {
        ...process.env,
        PROXY_FILE: proxyFile,
        UPSTREAM_CONCURRENCY: "2",
        LIGHTPANDA_PATH: join(dir, "must-not-be-checked"),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderr).toContain("UPSTREAM_CONCURRENCY must be 1");
    expect(stderr).not.toContain("LIGHTPANDA_PATH does not exist");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("local proxy file is excluded from Git and Docker contexts", async () => {
  const root = join(import.meta.dir, "..");
  const [gitignore, dockerignore] = await Promise.all([
    readFile(join(root, ".gitignore"), "utf8"),
    readFile(join(root, ".dockerignore"), "utf8"),
  ]);

  expect(gitignore.split(/\r?\n/)).toContain("PROXIES.txt");
  expect(dockerignore.split(/\r?\n/)).toContain("PROXIES.txt");
});
