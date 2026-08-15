import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { env, USER_AGENT } from "./constants.ts";

// Fallback hCaptcha API URL; overridden when the page provides its own script.
const HCAPTCHA_API_FALLBACK =
  "https://js.hcaptcha.com/1/api.js?render=explicit&onload=__hcLoad";
// hCaptcha tokens are domain-bound to the sitekey's registered origin
const blankOrigin = () => `https://build.nvidia.com/${env.model}`;
// Fallback sitekey used when the page does not expose one via data-sitekey.
const HCAPTCHA_SITEKEY_FALLBACK = "0c6a1e45-75d7-43cc-b836-a0c9d886b8ee";

// Ensure the hCaptcha API URL includes the render=explicit and onload params
// so the script calls window.__hcLoad() when ready.
function appendOnloadParam(src: string): string {
  const u = new URL(src);
  u.searchParams.set("render", "explicit");
  u.searchParams.set("onload", "__hcLoad");
  return u.toString();
}

// Build a Chrome UA from the CDP-reported version; falls back to the static
// UA when the version string is missing or malformed.
function userAgentFromVersion(cdpBrowser: string): string {
  const match = cdpBrowser.match(/Chrome\/(\d+\.\d+\.\d+\.\d+)/);
  if (match) {
    return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${match[1]} Safari/537.36`;
  }
  return USER_AGENT;
}

const CDP_READY_TIMEOUT_MS = 15_000;

const MINT_ATTEMPTS = 3;
const MINT_TIMEOUT_MS = 60_000;
const TOKEN_POLL_TIMEOUT_MS = 30_000;

/** Resolve `p`, or reject with `Error(msg)` after `ms`. The timer is always cleared. */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  msg: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(msg)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private context: BrowserContext | null = null;
  private proc: ChildProcess | null = null;
  private minting: Promise<string> | null = null;
  private sitekey = HCAPTCHA_SITEKEY_FALLBACK;
  private hcaptchaApiUrl = HCAPTCHA_API_FALLBACK;
  private opts: { lightpandaPath?: string };

  constructor(opts: { lightpandaPath?: string } = {}) {
    this.opts = opts;
  }

  /** Mint one fresh single-use hCaptcha token. Serialized; never reused. */
  async mintToken(): Promise<string> {
    if (this.minting) await this.minting.catch(() => {});
    this.minting = withTimeout(
      this.mintWithRetry(),
      MINT_TIMEOUT_MS,
      "hcaptcha mint timed out",
    ).catch(async (e) => {
      // Only a persistent failure reaches here; the browser is closed so the
      // next refill starts from a clean page instead of a stuck widget.
      await this.close();
      throw e;
    });
    try {
      return await this.minting;
    } finally {
      this.minting = null;
    }
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } finally {
      this.browser = null;
      this.page = null;
      this.context = null;
      this.proc?.kill();
      this.proc = null;
    }
  }

  /** Retry recoverable mint failures on the same page before giving up. */
  private async mintWithRetry(): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      try {
        return await this.mintTokenInner();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError;
  }

  private async ensureBrowser() {
    if (this.browser) return;
    const exe = this.opts.lightpandaPath;
    if (!exe) throw new Error("LIGHTPANDA_PATH not set");

    // Reserve a free port so we don't collide with another listener (adb uses 9222).
    const cdpPort = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => resolve(port));
      });
    });

    // Drive lightpanda over CDP instead of launching Chromium.
    this.proc = spawn(
      exe,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(cdpPort),
        "--log-level",
        "error",
      ],
      { stdio: "ignore" },
    );

    // Wait for the CDP endpoint before connecting.
    const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
    let cdpVersion: string | null = null;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${cdpPort}/json/version`);
        if (r.ok) {
          const v = (await r.json()) as { Browser?: string };
          cdpVersion = v.Browser ?? null;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!cdpVersion) throw new Error("lightpanda CDP endpoint not ready");

    this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
    this.context = await this.browser.newContext({
      userAgent: userAgentFromVersion(cdpVersion),
    });
    this.page = await this.context.newPage();
    await this.page.goto(blankOrigin(), {
      waitUntil: "domcontentloaded",
      timeout: MINT_TIMEOUT_MS,
    });

    // Extract the hCaptcha sitekey and API URL from the page; fall back to defaults.
    const scraped = await this.page.evaluate(() => {
      const keyEl = document.querySelector("[data-sitekey]");
      const scriptEl = document.querySelector<HTMLScriptElement>(
        "script[src*='hcaptcha']",
      );
      return {
        sitekey: keyEl?.getAttribute("data-sitekey") ?? null,
        apiUrl: scriptEl?.src ?? null,
      };
    });
    if (scraped.sitekey) this.sitekey = scraped.sitekey;
    if (scraped.apiUrl) {
      this.hcaptchaApiUrl = appendOnloadParam(scraped.apiUrl);
    }

    // Load hCaptcha api.js; it calls window.__hcLoad() when ready
    await this.page.evaluate((apiUrl) => {
      const w = window as unknown as Window & { __hcLoad?: () => void };
      return new Promise<void>((resolve, reject) => {
        w.__hcLoad = resolve;
        const s = document.createElement("script");
        s.src = apiUrl;
        s.onerror = () => reject(new Error("hcaptcha api.js load failed"));
        document.head.appendChild(s);
      });
    }, this.hcaptchaApiUrl);
  }

  private async mintTokenInner(): Promise<string> {
    await this.ensureBrowser();
    const page = this.page;
    if (!page) throw new Error("no page");

    const widgetId = await page.evaluate((sitekey) => {
      const w = window as unknown as Window & {
        hcaptcha: { render: (id: string, o: object) => string };
      };
      const div = document.createElement("div");
      div.id = `mint_${Date.now()}`;
      div.style.cssText =
        "position:fixed;left:10px;top:10px;width:300px;height:80px;z-index:99999";
      document.body.appendChild(div);
      return w.hcaptcha.render(div.id, { sitekey, size: "invisible" });
    }, this.sitekey);

    await page.evaluate((id) => {
      const w = window as unknown as Window & {
        hcaptcha: { execute: (id: string) => Promise<unknown> };
      };
      return w.hcaptcha.execute(id);
    }, widgetId);

    // Poll for the token instead of sleeping a fixed duration: latency tracks
    // the real solve time rather than a worst-case estimate.
    await page.waitForFunction(
      (id) => {
        const w = window as unknown as Window & {
          hcaptcha: { getResponse: (id: string) => string };
        };
        const token = w.hcaptcha.getResponse(id);
        return typeof token === "string" && token.startsWith("P1_");
      },
      widgetId,
      { timeout: TOKEN_POLL_TIMEOUT_MS },
    );

    const token = await page.evaluate((id) => {
      const w = window as unknown as Window & {
        hcaptcha: { getResponse: (id: string) => string };
      };
      return w.hcaptcha.getResponse(id);
    }, widgetId);
    if (typeof token !== "string" || !token.startsWith("P1_")) {
      throw new Error(
        `hcaptcha mint failed: expected P1_ token, got ${JSON.stringify(token?.slice(0, 40))}`,
      );
    }
    return token;
  }
}
