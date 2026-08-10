import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright-core";
import { BLANK_ORIGIN, HCAPTCHA_API, HCAPTCHA_SITEKEY } from "./constants";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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
  private minting: Promise<string> | null = null;

  constructor(
    private opts: {
      executablePath?: string;
      renderDelayMs?: number;
      executeWaitMs?: number;
    } = {},
  ) {}

  /** Mint one fresh single-use hCaptcha token. Serialized; never reused. */
  async mintToken(): Promise<string> {
    if (this.minting) await this.minting.catch(() => {});
    this.minting = withTimeout(
      this.mintTokenInner(),
      60_000,
      "hcaptcha mint timed out",
    ).catch(async (e) => {
      // close on every mint error: a hung execute or a partial launch would
      // otherwise leave the page unusable and brick the session
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
    }
  }

  private async ensureBrowser() {
    if (this.browser) return;
    this.browser = await chromium.launch({
      headless: true,
      executablePath: this.opts.executablePath,
    });
    this.context = await this.browser.newContext({ userAgent: USER_AGENT });
    this.page = await this.context.newPage();
    // render on build.nvidia.com: hCaptcha tokens are domain-bound to the sitekey's registered origin
    await this.page.goto(BLANK_ORIGIN, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // let the heavy SPA settle before injecting
    await new Promise((r) => setTimeout(r, 5000));
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
    }, HCAPTCHA_API);
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
    }, HCAPTCHA_SITEKEY);

    await new Promise((r) => setTimeout(r, this.opts.renderDelayMs ?? 3000));
    await page.evaluate((id) => {
      const w = window as unknown as Window & {
        hcaptcha: { execute: (id: string) => Promise<unknown> };
      };
      return w.hcaptcha.execute(id);
    }, widgetId);
    await new Promise((r) => setTimeout(r, this.opts.executeWaitMs ?? 8000));

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
