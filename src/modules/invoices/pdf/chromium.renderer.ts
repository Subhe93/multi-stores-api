/**
 * Headless Chromium PDF renderer through `playwright-core` (D7, §4.2, L12).
 *
 * - Nothing launches at boot: the browser starts on the first render.
 * - Browser selection: `INVOICE_PDF_CHROMIUM_PATH` (executablePath) or
 *   `INVOICE_PDF_BROWSER_CHANNEL` (msedge / chrome / chromium ...). With
 *   neither set, Windows dev boxes try the installed Edge, then Chrome; other
 *   platforms use Playwright's managed browser
 *   (`npx playwright install chromium-headless-shell`).
 * - Every request leaving the page is aborted and JavaScript is disabled:
 *   the HTML is self-contained and must never reach the network.
 * - At most 2 renders run at once; each is capped at 15 s.
 * - The browser closes after 5 minutes idle and is relaunched transparently
 *   after a crash / disconnect.
 * - A launch failure surfaces as PdfUnavailableError (503 upstream). Failed
 *   launches are not retried for 30 s so a missing browser does not cost a
 *   launch attempt per request.
 */
import { Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Browser, LaunchOptions } from 'playwright-core';
import {
  DisabledPdfRenderer,
  PdfUnavailableError,
  type PdfRenderer,
} from './pdf-renderer';

export interface ChromiumRendererOptions {
  executablePath?: string;
  channel?: string;
  concurrency?: number;
  timeoutMs?: number;
  idleCloseMs?: number;
  launchRetryAfterMs?: number;
}

const DEFAULTS = {
  concurrency: 2,
  timeoutMs: 15_000,
  idleCloseMs: 5 * 60_000,
  launchRetryAfterMs: 30_000,
};

type PlaywrightCore = typeof import('playwright-core');

/** Minimal FIFO semaphore. */
class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly max: number) {}

  get busy(): number {
    return this.active + this.waiters.length;
  }

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active--;
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${what} timed out after ${ms} ms`)),
      ms,
    );
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

export class ChromiumPdfRenderer implements PdfRenderer, OnModuleDestroy {
  private readonly logger = new Logger(ChromiumPdfRenderer.name);
  private readonly opts: Required<
    Omit<ChromiumRendererOptions, 'executablePath' | 'channel'>
  > &
    Pick<ChromiumRendererOptions, 'executablePath' | 'channel'>;
  private readonly sem: Semaphore;
  private browser: Browser | null = null;
  private launching: Promise<Browser> | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private lastLaunchFailure: { at: number; error: unknown } | null = null;
  /** Number of launches so far (exposed for the smoke spec). */
  launchCount = 0;

  constructor(options: ChromiumRendererOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.sem = new Semaphore(this.opts.concurrency);
  }

  async render(html: string, footerHtml: string): Promise<Buffer> {
    await this.sem.acquire();
    this.clearIdleTimer();
    try {
      try {
        return await this.renderOnce(html, footerHtml);
      } catch (err) {
        // The browser died under us (crash, OOM kill): relaunch once.
        if (err instanceof PdfUnavailableError || this.browser?.isConnected())
          throw err;
        this.logger.warn(
          `PDF render failed with a disconnected browser, relaunching: ${String(err)}`,
        );
        this.browser = null;
        return await this.renderOnce(html, footerHtml);
      }
    } finally {
      this.sem.release();
      this.scheduleIdleClose();
    }
  }

  private async renderOnce(html: string, footerHtml: string): Promise<Buffer> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({ javaScriptEnabled: false });
    try {
      await context.route('**/*', (route) => route.abort());
      const page = await context.newPage();
      page.setDefaultTimeout(this.opts.timeoutMs);
      const work = (async () => {
        await page.setContent(html, { waitUntil: 'load' });
        try {
          await page.evaluate('document.fonts.ready.then(() => true)');
        } catch {
          // Fonts are data URIs and already decoded by `load` in practice.
        }
        return page.pdf({
          format: 'A4',
          printBackground: true,
          displayHeaderFooter: true,
          headerTemplate: '<span></span>',
          footerTemplate: footerHtml,
          preferCSSPageSize: true,
        });
      })();
      return await withTimeout(work, this.opts.timeoutMs, 'PDF render');
    } finally {
      await context.close().catch(() => undefined);
    }
  }

  private async getBrowser(): Promise<Browser> {
    if (this.browser?.isConnected()) return this.browser;
    if (this.launching) return this.launching;
    const recent = this.lastLaunchFailure;
    if (recent && Date.now() - recent.at < this.opts.launchRetryAfterMs) {
      throw new PdfUnavailableError(
        'PDF engine could not start (recent failure)',
        {
          cause: recent.error,
        },
      );
    }
    this.launching = this.launch().finally(() => {
      this.launching = null;
    });
    return this.launching;
  }

  /** Launch candidates in order of preference. */
  private candidates(): LaunchOptions[] {
    const args: string[] = [];
    // Chromium refuses to start sandboxed as root (common in containers).
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      args.push('--no-sandbox');
    }
    const base: LaunchOptions = { headless: true, args };
    if (this.opts.executablePath) {
      return [{ ...base, executablePath: this.opts.executablePath }];
    }
    if (this.opts.channel) return [{ ...base, channel: this.opts.channel }];
    if (process.platform === 'win32') {
      return [
        { ...base, channel: 'msedge' },
        { ...base, channel: 'chrome' },
        base,
      ];
    }
    return [base];
  }

  private async launch(): Promise<Browser> {
    let pw: PlaywrightCore;
    try {
      // Loaded lazily so the API boots without touching the package.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      pw = require('playwright-core') as PlaywrightCore;
    } catch (error) {
      this.lastLaunchFailure = { at: Date.now(), error };
      throw new PdfUnavailableError('playwright-core is not installed', {
        cause: error,
      });
    }
    let lastError: unknown;
    for (const opts of this.candidates()) {
      try {
        const browser = await pw.chromium.launch({
          ...opts,
          timeout: this.opts.timeoutMs,
        });
        browser.on('disconnected', () => {
          if (this.browser === browser) this.browser = null;
        });
        this.browser = browser;
        this.lastLaunchFailure = null;
        this.launchCount++;
        this.logger.log(
          `PDF browser launched (${opts.executablePath ?? opts.channel ?? 'playwright default'})`,
        );
        return browser;
      } catch (error) {
        lastError = error;
      }
    }
    this.lastLaunchFailure = { at: Date.now(), error: lastError };
    this.logger.warn(
      `PDF browser could not be launched; invoice PDFs are unavailable: ${
        String((lastError as Error)?.message ?? lastError).split('\n')[0]
      }`,
    );
    throw new PdfUnavailableError('PDF engine could not start', {
      cause: lastError,
    });
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private scheduleIdleClose(): void {
    if (this.sem.busy > 0 || !this.browser) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.sem.busy === 0) void this.close();
    }, this.opts.idleCloseMs);
    this.idleTimer.unref?.();
  }

  /** Closes the browser (idle timeout / shutdown). Safe to call repeatedly. */
  async close(): Promise<void> {
    this.clearIdleTimer();
    const b = this.browser;
    this.browser = null;
    if (b) await b.close().catch(() => undefined);
  }

  async onModuleDestroy(): Promise<void> {
    await this.close();
  }
}

/**
 * Picks the renderer from the environment:
 *   INVOICE_PDF_ENGINE=off|disabled|none → DisabledPdfRenderer
 *   anything else (default 'chromium')   → ChromiumPdfRenderer
 */
export function createPdfRenderer(
  env: NodeJS.ProcessEnv = process.env,
): PdfRenderer {
  const engine = String(env.INVOICE_PDF_ENGINE ?? 'chromium')
    .trim()
    .toLowerCase();
  if (['off', 'disabled', 'none', 'false', '0'].includes(engine)) {
    return new DisabledPdfRenderer();
  }
  return new ChromiumPdfRenderer({
    executablePath: env.INVOICE_PDF_CHROMIUM_PATH?.trim() || undefined,
    channel: env.INVOICE_PDF_BROWSER_CHANNEL?.trim() || undefined,
  });
}
