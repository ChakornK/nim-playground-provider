import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type AddressInfo } from "node:net";
import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { env, USER_AGENT } from "./constants.ts";

const HCAPTCHA_API_FALLBACK =
  "https://js.hcaptcha.com/1/api.js?render=explicit&onload=__hcLoad";
// hCaptcha tokens are domain-bound to the sitekey origin
const blankOrigin = () => `https://build.nvidia.com/${env.model}`;
const HCAPTCHA_SITEKEY_FALLBACK = "0c6a1e45-75d7-43cc-b836-a0c9d886b8ee";

function appendOnloadParam(src: string): string {
  const u = new URL(src);
  u.searchParams.set("render", "explicit");
  u.searchParams.set("onload", "__hcLoad");
  return u.toString();
}

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
  // Persistent invisible widget, reused via reset+execute to avoid per-mint leakage
  private widgetId: string | null = null;
  private opts: { lightpandaPath?: string };

  constructor(opts: { lightpandaPath?: string } = {}) {
    this.opts = opts;
  }

  /** Mint one fresh single-use hCaptcha token. Serialized, never reused. */
  async mintToken(): Promise<string> {
    if (this.minting) await this.minting.catch(() => {});
    this.minting = withTimeout(
      this.mintWithRetry(),
      MINT_TIMEOUT_MS,
      "hcaptcha mint timed out",
    ).catch(async (e) => {
      // Persistent failure, close browser so next mint starts clean
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
      this.widgetId = null;
      this.proc?.kill();
      this.proc = null;
    }
  }

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

    const cdpPort = await new Promise<number>((resolve, reject) => {
      const s = createServer();
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => {
        const port = (s.address() as AddressInfo).port;
        s.close(() => resolve(port));
      });
    });

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

    // Load hCaptcha api.js, calls __hcLoad() when ready
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

    this.widgetId = await this.page.evaluate((sitekey) => {
      const w = window as unknown as Window & {
        hcaptcha: { render: (id: string, o: object) => string };
      };
      const div = document.createElement("div");
      div.id = "mint_widget";
      div.style.cssText =
        "position:fixed;left:-9999px;top:0;width:300px;height:80px";
      document.body.appendChild(div);
      return w.hcaptcha.render(div.id, { sitekey, size: "invisible" });
    }, this.sitekey);
  }

  private async mintTokenInner(): Promise<string> {
    await this.ensureBrowser();
    const page = this.page;
    if (!page) throw new Error("no page");
    const widgetId = this.widgetId;
    if (!widgetId) throw new Error("no widget");

    await page.evaluate((id) => {
      const w = window as unknown as Window & {
        hcaptcha: {
          reset: (id: string) => void;
          execute: (id: string) => Promise<unknown>;
        };
      };
      w.hcaptcha.reset(id);
      return w.hcaptcha.execute(id);
    }, widgetId);

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
