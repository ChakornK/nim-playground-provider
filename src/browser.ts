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

const debugCaptcha = (...args: unknown[]) => {
  if (process.env.DEBUG_CAPTCHA) console.error("[captcha]", ...args);
};

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
const MINT_TIMEOUT_MS = 120_000;
const TOKEN_POLL_TIMEOUT_MS = 45_000;

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

export async function withAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  message: string,
): Promise<T> {
  if (signal.aborted) {
    const error = new Error(message);
    error.name = "AbortError";
    throw error;
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => {
          const error = new Error(message);
          error.name = "AbortError";
          reject(error);
        };
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

export class BrowserSession {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private proc: ChildProcess | null = null;
  private stealth: StealthProxy | null = null;
  private minting: Promise<string> | null = null;
  private starting: Promise<void> | null = null;
  private resetController = new AbortController();
  private mintGen = 0;
  private readyGen = -1;
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
    const resetSignal = this.resetController.signal;
    const minting = prev
      .catch(() => {})
      .then(() =>
        withTimeout(
          withAbort(this.mintWithRetry(), resetSignal, "hcaptcha mint reset"),
          MINT_TIMEOUT_MS,
          "hcaptcha mint timed out",
        ),
      )
      .catch(async (e) => {
        const resetAbort =
          e instanceof Error &&
          (e.message === "hcaptcha mint reset" ||
            e.message === "mint superseded");
        if (!resetAbort) await this.reset();
        throw e;
      });
    this.minting = minting;
    return minting;
  }

  /** Reset the browser and widget after NVIDIA rejects a token. */
  async reset(): Promise<void> {
    const resetController = this.resetController;
    this.resetController = new AbortController();
    this.mintGen++;
    this.readyGen = -1;
    this.starting = null;
    resetController.abort();
    const browser = this.browser;
    const proc = this.proc;
    const stealth = this.stealth;
    this.browser = null;
    this.page = null;
    this.widgetId = null;
    this.proc = null;
    this.stealth = null;

    proc?.kill();
    await Promise.allSettled([
      browser
        ? withTimeout(browser.close(), 2_000, "browser close timed out")
        : Promise.resolve(),
      stealth
        ? withTimeout(stealth.stop(), 2_000, "stealth proxy stop timed out")
        : Promise.resolve(),
    ]);
    if (proc?.exitCode === null) proc.kill("SIGKILL");
  }

  async close(): Promise<void> {
    await this.reset();
  }

  private assertCurrent(gen: number): void {
    if (this.mintGen !== gen) throw new Error("mint superseded");
  }

  private async mintWithRetry(): Promise<string> {
    const gen = this.mintGen;
    let lastError: unknown;
    for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
      this.assertCurrent(gen);
      try {
        return await this.mintTokenInner(gen);
      } catch (err) {
        lastError = err;
        this.assertCurrent(gen);
        if (attempt + 1 < MINT_ATTEMPTS) {
          await new Promise((resolve) =>
            setTimeout(resolve, 500 * 2 ** attempt),
          );
        }
      }
    }
    throw lastError;
  }

  private async ensureBrowser(gen: number): Promise<void> {
    if (this.readyGen === gen && this.browser && this.page && this.widgetId) {
      return;
    }
    let starting = this.starting;
    if (!starting) {
      starting = this.startBrowser(gen);
      this.starting = starting;
      const clear = () => {
        if (this.starting === starting) this.starting = null;
      };
      starting.then(clear, clear);
    }
    await starting;
    this.assertCurrent(gen);
    if (!this.browser || !this.page || !this.widgetId) {
      throw new Error("browser session did not initialize");
    }
  }

  private async startBrowser(gen: number): Promise<void> {
    this.assertCurrent(gen);
    debugCaptcha("starting browser");
    const exe = this.opts.lightpandaPath;
    if (!exe) throw new Error("LIGHTPANDA_PATH not set");

    const cdpPort = await new Promise<number>((resolve, reject) => {
      const server = createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const port = (server.address() as AddressInfo).port;
        server.close(() => resolve(port));
      });
    });
    this.assertCurrent(gen);

    // Route lightpanda through a header-rewriting MITM proxy so the network
    // fingerprint matches commercial Chrome (its own UA override refuses
    // Chrome strings and always hints Lightpanda via sec-ch-ua).
    let proxyArgs: string[] = [];
    let stealth: StealthProxy | null = null;
    try {
      stealth = new StealthProxy();
      debugCaptcha("starting stealth proxy");
      const { proxyUrl, caCertPath } = await withTimeout(
        stealth.start(),
        15_000,
        "stealth proxy startup timed out",
      );
      this.assertCurrent(gen);
      debugCaptcha("stealth proxy ready", proxyUrl);
      proxyArgs = ["--http-proxy", proxyUrl, "--ca-cert", caCertPath];
    } catch (e) {
      if (stealth) {
        await withTimeout(
          stealth.stop(),
          2_000,
          "stealth proxy stop timed out",
        ).catch(() => {});
      }
      if (this.mintGen !== gen) throw e;
      console.warn(
        `[browser] stealth proxy unavailable (${(e as Error).message}); lightpanda runs unmasked`,
      );
      stealth = null;
    }
    this.stealth = stealth;

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
    proc.on("error", () => {});
    this.proc = proc;

    let browser: Browser | null = null;
    let page: Page | null = null;
    let widgetId: string | null = null;
    try {
      const deadline = Date.now() + CDP_READY_TIMEOUT_MS;
      let cdpVersion: string | null = null;
      while (Date.now() < deadline) {
        this.assertCurrent(gen);
        try {
          const response = await fetch(
            `http://127.0.0.1:${cdpPort}/json/version`,
          );
          if (response.ok) {
            const version = (await response.json()) as { Browser?: string };
            cdpVersion = version.Browser ?? null;
            break;
          }
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      this.assertCurrent(gen);
      if (!cdpVersion) throw new Error("lightpanda CDP endpoint not ready");
      debugCaptcha("CDP ready", cdpVersion);

      browser = await chromium.connectOverCDP(`http://127.0.0.1:${cdpPort}`);
      this.assertCurrent(gen);
      this.browser = browser;
      debugCaptcha("CDP connected");
      const ua = userAgentFromVersion(cdpVersion);
      const context = await browser.newContext({ userAgent: ua });
      this.assertCurrent(gen);
      await addChromeSpoof(context, ua);
      this.assertCurrent(gen);
      // hCaptcha only needs the correct build.nvidia.com origin and sitekey.
      // Loading NVIDIA's full app pulls dozens of irrelevant analytics/assets
      // through the MITM proxy and can consume the whole mint deadline.
      await context.route(blankOrigin(), (route) =>
        route.fulfill({
          status: 200,
          contentType: "text/html",
          body: "<!doctype html><html><head></head><body></body></html>",
        }),
      );
      this.assertCurrent(gen);
      page = await context.newPage();
      this.assertCurrent(gen);
      this.page = page;
      debugCaptcha("loading NVIDIA origin");
      await page.goto(blankOrigin(), {
        waitUntil: "domcontentloaded",
        timeout: MINT_TIMEOUT_MS,
      });
      this.assertCurrent(gen);

      debugCaptcha("NVIDIA origin loaded");
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
      this.assertCurrent(gen);
      if (scraped.sitekey) this.sitekey = scraped.sitekey;
      if (scraped.apiUrl) {
        this.hcaptchaApiUrl = appendOnloadParam(scraped.apiUrl);
      }

      debugCaptcha("loading hCaptcha API", this.hcaptchaApiUrl);
      await page.evaluate((apiUrl) => {
        const w = window as unknown as HCaptchaWindow;
        return new Promise<void>((resolve, reject) => {
          w.__hcLoad = resolve;
          const script = document.createElement("script");
          script.src = apiUrl;
          script.onerror = () =>
            reject(new Error("hcaptcha api.js load failed"));
          document.head.appendChild(script);
        });
      }, this.hcaptchaApiUrl);
      this.assertCurrent(gen);

      debugCaptcha("hCaptcha API ready");
      widgetId = await page.evaluate((sitekey) => {
        const w = window as unknown as HCaptchaWindow;
        const div = document.createElement("div");
        div.id = "mint_widget";
        div.style.cssText =
          "position:fixed;left:-9999px;top:0;width:300px;height:80px";
        document.body.appendChild(div);
        return w.hcaptcha.render(div.id, { sitekey, size: "invisible" });
      }, this.sitekey);
      this.assertCurrent(gen);

      debugCaptcha("hCaptcha widget ready", widgetId);
      this.widgetId = widgetId;
      this.readyGen = gen;
    } catch (e) {
      if (this.proc === proc) this.proc = null;
      if (this.browser === browser) this.browser = null;
      if (this.page === page) this.page = null;
      if (this.stealth === stealth) this.stealth = null;
      if (this.widgetId === widgetId) this.widgetId = null;
      if (this.readyGen === gen) this.readyGen = -1;
      proc.kill();
      await Promise.allSettled([
        browser
          ? withTimeout(browser.close(), 2_000, "browser close timed out")
          : Promise.resolve(),
        stealth
          ? withTimeout(stealth.stop(), 2_000, "stealth proxy stop timed out")
          : Promise.resolve(),
      ]);
      throw e;
    }
  }

  private async mintTokenInner(gen: number): Promise<string> {
    await this.ensureBrowser(gen);
    this.assertCurrent(gen);
    const page = this.page;
    if (!page) throw new Error("no page");
    const widgetId = this.widgetId;
    if (!widgetId) throw new Error("no widget");

    debugCaptcha("executing hCaptcha widget");
    await page.evaluate((id) => {
      const w = window as unknown as HCaptchaWindow;
      w.hcaptcha.reset(id);
      return w.hcaptcha.execute(id);
    }, widgetId);
    this.assertCurrent(gen);

    debugCaptcha("waiting for captcha token");
    await page.waitForFunction(
      (id) => {
        const w = window as unknown as HCaptchaWindow;
        const token = w.hcaptcha.getResponse(id);
        return typeof token === "string" && token.startsWith("P1_");
      },
      widgetId,
      { timeout: TOKEN_POLL_TIMEOUT_MS },
    );
    this.assertCurrent(gen);

    debugCaptcha("captcha token received");
    const token = await page.evaluate((id) => {
      const w = window as unknown as HCaptchaWindow;
      return w.hcaptcha.getResponse(id);
    }, widgetId);
    this.assertCurrent(gen);
    if (typeof token !== "string" || !token.startsWith("P1_")) {
      throw new Error(
        `hcaptcha mint failed: expected P1_ token, got ${JSON.stringify(token?.slice(0, 40))}`,
      );
    }
    return token;
  }
}
