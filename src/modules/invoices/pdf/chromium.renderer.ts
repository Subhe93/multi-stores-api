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
import type { OnModuleDestroy } from '@nestjs/common';
import {
  BrowserHost,
  withTimeout,
  type BrowserHostOptions,
} from '../../../common/chromium/browser-host';
import {
  DisabledPdfRenderer,
  PdfUnavailableError,
  type PdfRenderer,
} from './pdf-renderer';

export type ChromiumRendererOptions = Omit<
  BrowserHostOptions,
  'args' | 'recycleAfterJobs'
>;

const DEFAULT_TIMEOUT_MS = 15_000;

export class ChromiumPdfRenderer implements PdfRenderer, OnModuleDestroy {
  // Launcher, semaphore, idle close and relaunch live in the shared
  // BrowserHost (common/chromium/browser-host.ts, M4.2 §5.1).
  private readonly host: BrowserHost;
  private readonly timeoutMs: number;

  constructor(options: ChromiumRendererOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.host = new BrowserHost(
      { ...options, timeoutMs: this.timeoutMs },
      {
        loggerName: ChromiumPdfRenderer.name,
        label: 'PDF',
        unavailableNote: 'invoice PDFs are unavailable',
        unavailable: (message, cause) =>
          new PdfUnavailableError(message, { cause }),
        isUnavailable: (err) => err instanceof PdfUnavailableError,
      },
    );
  }

  /** Number of launches so far (exposed for the smoke spec). */
  get launchCount(): number {
    return this.host.launchCount;
  }

  render(html: string, footerHtml: string): Promise<Buffer> {
    return this.host.withBrowser(async (browser) => {
      const context = await browser.newContext({ javaScriptEnabled: false });
      try {
        await context.route('**/*', (route) => route.abort());
        const page = await context.newPage();
        page.setDefaultTimeout(this.timeoutMs);
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
        return await withTimeout(work, this.timeoutMs, 'PDF render');
      } finally {
        await context.close().catch(() => undefined);
      }
    });
  }

  /** Closes the browser (idle timeout / shutdown). Safe to call repeatedly. */
  async close(): Promise<void> {
    await this.host.close();
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
