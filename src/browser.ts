import { type ChildProcess, spawn } from "node:child_process";
import { type AddressInfo, createServer } from "node:net";
import {
  type Browser,
  type BrowserContext,
  chromium,
  type Page,
} from "playwright-core";
import { env, USER_AGENT } from "./constants.ts";
import { StealthProxy } from "./stealth.ts";

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

/** Aligns navigator.* with the Chrome Linux identity the wire headers now
 * claim (lightpanda is Chromium-based and otherwise leaks itself). */
function addChromeSpoof(context: BrowserContext, ua: string) {
  return context.addInitScript((ua2: string) => {
    const v = /Chrome\/(\d+)/.exec(ua2)?.[1] ?? "124";
    Object.defineProperty(navigator, "userAgent", { get: () => ua2 });
    Object.defineProperty(navigator, "appVersion", {
      get: () => ua2.replace(/^Mozilla\//, ""),
    });
    Object.defineProperty(navigator, "vendor", { get: () => "Google Inc." });
    Object.defineProperty(navigator, "vendorSub", { get: () => "" });
    Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" });
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 0 });
    Object.defineProperty(navigator, "userAgentData", {
      get: () => ({
        brands: [
          { brand: "Chromium", version: v },
          { brand: "Google Chrome", version: v },
          { brand: "Not-A.Brand", version: "99" },
        ],
        mobile: false,
        platform: "Linux",
        getHighEntropyValues: () =>
          Promise.resolve({
            architecture: "x86",
            bitness: "64",
            model: "",
            platformVersion: "6.8.0",
            uaFullVersion: `${v}.0.0.0`,
            fullVersionList: [
              { brand: "Chromium", version: `${v}.0.0.0` },
              { brand: "Google Chrome", version: `${v}.0.0.0` },
              { brand: "Not-A.Brand", version: "99.0.0.0" },
            ],
            wow64: false,
          }),
        toJSON: () => ({}),
      }),
    });
    if (!("chrome" in window)) {
      Object.defineProperty(window, "chrome", {
        get: () => ({
          runtime: {},
          app: {},
          csi: () => ({}),
          loadTimes: () => ({}),
        }),
      });
    }
  }, ua);
}

const CDP_READY_TIMEOUT_MS = 15_000;

const MINT_ATTEMPTS = 3;
const MINT_TIMEOUT_MS = 60_000;
const TOKEN_POLL_TIMEOUT_MS = 30_000;

interface HCaptchaWindow extends Window {
  __hcLoad?: () => void;
  hcaptcha: {
    render(id: string, o: object): string;
    reset(id: string): void;
    execute(id: string): Promise<unknown>;
    getResponse(id: string): string;
  };
}

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
  private stealth: StealthProxy | null = null;
  private minting: Promise<string> | null = null;
  private mintGen = 0;
  private sitekey = HCAPTCHA_SITEKEY_FALLBACK;
  private hcaptchaApiUrl = HCAPTCHA_API_FALLBACK;
  // Persistent invisible widget, reused via reset+execute to avoid per-mint leakage
  private widgetId: string | null = null;
  private opts: { lightpandaPath?: string };

  constructor(opts: { lightpandaPath?: string } = {}) {
    this.opts = opts;
  }

  /** Mint one fresh single-use hCaptcha token. Chained so concurrent callers
   * never overlap on the shared widget. */
  async mintToken(): Promise<string> {
    const prev: Promise<unknown> = this.minting ?? Promise.resolve();
    const minting = prev
      .catch(() => {})
      .then(() =>
        withTimeout(
          this.mintWithRetry(),
          MINT_TIMEOUT_MS,
          "hcaptcha mint timed out",
        ),
      )
      .catch(async (e) => {
        // Persistent failure, close browser so next mint starts clean. Bumping
        // the generation stops the retry loop orphaned by the timeout.
        this.mintGen++;
        await this.close();
        throw e;
      });
    this.minting = minting;
    return minting;
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
      const stealth = this.stealth;
      this.stealth = null;
      await stealth?.stop();
    }
  }

  private async mintWithRetry(): Promise<string> {
    const gen = this.mintGen;
    let lastError: unknown;
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      // A timed-out mint's chain has moved on; don't respawn the browser.
      if (this.mintGen !== gen) throw new Error("mint superseded");
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

    // Route lightpanda through a header-rewriting MITM proxy so the network
    // fingerprint matches commercial Chrome (its own UA override refuses
    // Chrome strings and always hints Lightpanda via sec-ch-ua).
    let proxyArgs: string[] = [];
    let stealth: StealthProxy | null = null;
    try {
      stealth = new StealthProxy();
      const { proxyUrl, caCertPath } = await stealth.start();
      proxyArgs = ["--http-proxy", proxyUrl, "--ca-cert", caCertPath];
    } catch (e) {
      console.warn(
        `[browser] stealth proxy unavailable (${(e as Error).message}); lightpanda runs unmasked`,
      );
      stealth = null;
    }

    const proc = spawn(
      exe,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(cdpPort),
        "--log-level",
        "error",
        ...proxyArgs,
      ],
      { stdio: "ignore" },
    );
    // The CDP-ready poll turns a spawn failure into a catchable timeout.
    proc.on("error", () => {});

    // Any failure below leaves no half-initialized state behind; the next
    // attempt starts from scratch.
    try {
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

      const browser = await chromium.connectOverCDP(
        `http://127.0.0.1:${cdpPort}`,
      );
      const ua = userAgentFromVersion(cdpVersion);
      const context = await browser.newContext({ userAgent: ua });
      await addChromeSpoof(context, ua);
      const page = await context.newPage();
      await page.goto(blankOrigin(), {
        waitUntil: "domcontentloaded",
        timeout: MINT_TIMEOUT_MS,
      });

      const scraped = await page.evaluate(() => {
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
      await page.evaluate((apiUrl) => {
        const w = window as unknown as HCaptchaWindow;
        return new Promise<void>((resolve, reject) => {
          w.__hcLoad = resolve;
          const s = document.createElement("script");
          s.src = apiUrl;
          s.onerror = () => reject(new Error("hcaptcha api.js load failed"));
          document.head.appendChild(s);
        });
      }, this.hcaptchaApiUrl);

      const widgetId = await page.evaluate((sitekey) => {
        const w = window as unknown as HCaptchaWindow;
        const div = document.createElement("div");
        div.id = "mint_widget";
        div.style.cssText =
          "position:fixed;left:-9999px;top:0;width:300px;height:80px";
        document.body.appendChild(div);
        return w.hcaptcha.render(div.id, { sitekey, size: "invisible" });
      }, this.sitekey);

      this.proc = proc;
      this.stealth = stealth;
      this.browser = browser;
      this.context = context;
      this.page = page;
      this.widgetId = widgetId;
    } catch (e) {
      proc.kill();
      await stealth?.stop();
      throw e;
    }
  }

  private async mintTokenInner(): Promise<string> {
    await this.ensureBrowser();
    const page = this.page;
    if (!page) throw new Error("no page");
    const widgetId = this.widgetId;
    if (!widgetId) throw new Error("no widget");

    await page.evaluate((id) => {
      const w = window as unknown as HCaptchaWindow;
      w.hcaptcha.reset(id);
      return w.hcaptcha.execute(id);
    }, widgetId);

    await page.waitForFunction(
      (id) => {
        const w = window as unknown as HCaptchaWindow;
        const token = w.hcaptcha.getResponse(id);
        return typeof token === "string" && token.startsWith("P1_");
      },
      widgetId,
      { timeout: TOKEN_POLL_TIMEOUT_MS },
    );

    const token = await page.evaluate((id) => {
      const w = window as unknown as HCaptchaWindow;
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
