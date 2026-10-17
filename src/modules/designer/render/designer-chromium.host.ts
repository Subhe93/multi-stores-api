/**
 * Designer render host (M4.2 §5.1, D3): its own Chromium instance on the
 * shared BrowserHost, never the invoice pool (that one runs with JS off and
 * aborts every request).
 *
 * - JS on, service workers blocked, downloads off, a 64×64 viewport.
 * - `context.route('**\/*')` fulfils only `https://designer.invalid/<path>`
 *   from the job's in-memory file map and aborts everything else, so a
 *   render never touches the network.
 * - Two lanes on one browser, so proofs never starve print files and the
 *   reverse: `proof` (1 slot, at most 8 waiting, 5 s acquire timeout) and
 *   `print` (DESIGNER_RENDER_CONCURRENCY slots, 1 or 2, at most 4 waiting,
 *   60 s acquire timeout). A full lane answers 503 DESIGNER_RENDER_UNAVAILABLE
 *   at once. Idle close after 5 min; the browser is recycled every 50 jobs
 *   (memory bound) and relaunched after a crash.
 * - Canvas size guard: a job whose canvas exceeds DESIGNER_MAX_CANVAS_PIXELS
 *   or DESIGNER_MAX_CANVAS_SIDE fails with CANVAS_TOO_LARGE before the
 *   browser is touched (the render service clamps scales below that).
 * - Determinism: software raster (`--disable-gpu`) and a fixed sRGB output
 *   profile, so the same input gives the same pixels.
 * - A hung job never wedges a lane: the page work is bounded by the job
 *   timeout, and the context close by CONTEXT_CLOSE_TIMEOUT_MS; when the
 *   close itself hangs the whole browser is closed (and relaunched by the
 *   next job).
 * - Photo crops (print memory, M4.2 §5.2): an asset may carry a `crop` (the
 *   visible fraction of the original the server pre-cut and pre-scaled);
 *   the page remaps `drawImage` of that bitmap to the matching sub-rect, so
 *   the shared renderer still thinks in whole images.
 *
 * Environment: DESIGNER_RENDER_ENGINE (chromium | off), DESIGNER_CHROMIUM_PATH,
 * DESIGNER_BROWSER_CHANNEL; the last two fall back to INVOICE_PDF_CHROMIUM_PATH
 * / INVOICE_PDF_BROWSER_CHANNEL.
 */
import { Logger, ServiceUnavailableException } from '@nestjs/common';
import type { BrowserContext, Route } from 'playwright-core';
import {
  BrowserHost,
  withTimeout,
  type BrowserHostOptions,
  type BrowserLaneOptions,
} from '../../../common/chromium/browser-host';
import {
  canvasSize,
  type DesignStateV1,
  type Mode,
  type RenderReport,
  type TemplateSpecV1,
} from './design-renderer';
import {
  RENDER_ORIGIN,
  RENDER_PAGE_HTML,
  RENDER_PAGE_SCRIPT,
  RENDER_PAGE_URL,
  rendererBundle,
} from './render-page';

/** Nest injection token of the `DesignerBrowserRenderer`. */
export const DESIGNER_BROWSER = Symbol('DESIGNER_BROWSER');

/** One in-memory file the page may request. */
export interface RenderFile {
  body: Buffer;
  contentType: string;
}

/** Visible fraction of an original the served bytes were cut to (0..1). */
export interface CropFraction {
  fx: number;
  fy: number;
  fw: number;
  fh: number;
}

/** One image of a canvas job; its bytes are in `files` under `a/<id>`. */
export interface CanvasAsset {
  id: string;
  /** Set when the served bytes are a crop of the original. */
  crop?: CropFraction;
}

export interface CanvasJob {
  spec: TemplateSpecV1;
  state: DesignStateV1;
  mode: Mode;
  /** px per mm. */
  scale: number;
  locale?: string;
  /** Output encoding of the canvas. */
  type: 'image/png' | 'image/webp';
  quality?: number;
  fonts: { family: string; weight: number; style: string; asset_id: string }[];
  /** Image assets; their bytes are in `files` under `a/<id>`. */
  assets: CanvasAsset[];
}

export interface CanvasResult {
  data: Buffer;
  width: number;
  height: number;
  report: RenderReport;
}

/** The seam the render service talks to (mocked in specs). */
export interface DesignerBrowserRenderer {
  readonly enabled: boolean;
  /**
   * Renders one surface. `files` maps `f/<asset_id>` (fonts) and
   * `a/<asset_id>` (images) to bytes.
   * @throws DesignerRenderUnavailableError when the engine is off / cannot start
   */
  renderCanvas(
    job: CanvasJob,
    files: Map<string, RenderFile>,
    timeoutMs: number,
  ): Promise<CanvasResult>;
  /**
   * Makes sure the engine can render (launches the browser when needed)
   * without rendering anything.
   * @throws DesignerRenderUnavailableError when the engine is off / cannot start
   */
  probe(): Promise<void>;
  close(): Promise<void>;
}

/** Upper bound of one `context.close()` (ms) before the browser is closed. */
export const CONTEXT_CLOSE_TIMEOUT_MS = 5_000;

/** The engine is disabled or the browser could not start (503 upstream). */
export class DesignerRenderUnavailableError extends ServiceUnavailableException {
  readonly code = 'DESIGNER_RENDER_UNAVAILABLE';

  constructor(message = 'Design rendering is unavailable', cause?: unknown) {
    super(
      { code: 'DESIGNER_RENDER_UNAVAILABLE', message },
      cause !== undefined ? { cause } : undefined,
    );
    this.name = 'DesignerRenderUnavailableError';
  }
}

export interface DesignerChromiumOptions extends Omit<
  BrowserHostOptions,
  'args' | 'lanes'
> {
  /** Extra switches on top of the determinism switches. */
  args?: string[];
  /** Slots of the print lane (DESIGNER_RENDER_CONCURRENCY: 1 or 2). */
  printConcurrency?: number;
  /** Overrides of the lane limits (specs). */
  proofLane?: Partial<BrowserLaneOptions>;
  printLane?: Partial<BrowserLaneOptions>;
}

/** Hard ceiling of one canvas (defence in depth; the service clamps lower). */
export const DESIGNER_MAX_CANVAS_PIXELS = 80_000_000;
/** Chromium's per-side canvas limit is 32 767; stay well inside it. */
export const DESIGNER_MAX_CANVAS_SIDE = 16_384;

/** Lane of the browser host a render mode runs in. */
export type DesignerRenderLane = 'proof' | 'print';

export const DESIGNER_PROOF_LANE = {
  concurrency: 1,
  maxQueue: 8,
  acquireTimeoutMs: 5_000,
} as const;
export const DESIGNER_PRINT_LANE = {
  concurrency: 1,
  maxQueue: 4,
  acquireTimeoutMs: 60_000,
} as const;

/** Chromium switches that keep canvas output reproducible. */
export const DESIGNER_CHROMIUM_ARGS = [
  '--disable-gpu',
  '--force-color-profile=srgb',
  '--disable-extensions',
  '--mute-audio',
];

export class DesignerChromiumHost implements DesignerBrowserRenderer {
  readonly enabled = true;
  readonly host: BrowserHost;
  private readonly logger = new Logger(DesignerChromiumHost.name);

  constructor(options: DesignerChromiumOptions = {}) {
    const { printConcurrency, proofLane, printLane, ...hostOptions } = options;
    this.host = new BrowserHost(
      {
        concurrency: 1,
        timeoutMs: 30_000,
        idleCloseMs: 5 * 60_000,
        recycleAfterJobs: 50,
        ...hostOptions,
        args: [...DESIGNER_CHROMIUM_ARGS, ...(options.args ?? [])],
        lanes: {
          proof: { ...DESIGNER_PROOF_LANE, ...(proofLane ?? {}) },
          print: {
            ...DESIGNER_PRINT_LANE,
            concurrency: printConcurrency === 2 ? 2 : 1,
            ...(printLane ?? {}),
          },
        },
      },
      {
        loggerName: DesignerChromiumHost.name,
        label: 'Designer',
        unavailableNote: 'design proofs and print files are unavailable',
        unavailable: (message, cause) =>
          new DesignerRenderUnavailableError(message, cause),
        isUnavailable: (err) => err instanceof DesignerRenderUnavailableError,
      },
    );
  }

  get launchCount(): number {
    return this.host.launchCount;
  }

  probe(): Promise<void> {
    return this.host.ensureBrowser();
  }

  renderCanvas(
    job: CanvasJob,
    files: Map<string, RenderFile>,
    timeoutMs: number,
  ): Promise<CanvasResult> {
    const size = job.spec ? canvasSize(job.spec, job.scale) : null;
    if (
      size &&
      (!(size.width > 0 && size.height > 0) ||
        size.width > DESIGNER_MAX_CANVAS_SIDE ||
        size.height > DESIGNER_MAX_CANVAS_SIDE ||
        size.width * size.height > DESIGNER_MAX_CANVAS_PIXELS)
    ) {
      return Promise.reject(
        new Error(`CANVAS_TOO_LARGE:${size.width}x${size.height}`),
      );
    }
    const lane: DesignerRenderLane = job.mode === 'print' ? 'print' : 'proof';
    const served = new Map<string, RenderFile>(files);
    served.set('render.html', {
      body: Buffer.from(RENDER_PAGE_HTML),
      contentType: 'text/html; charset=utf-8',
    });
    served.set('renderer.js', {
      body: Buffer.from(rendererBundle()),
      contentType: 'application/javascript; charset=utf-8',
    });
    served.set('page.js', {
      body: Buffer.from(RENDER_PAGE_SCRIPT),
      contentType: 'application/javascript; charset=utf-8',
    });
    const pageJob = {
      spec: job.spec,
      state: job.state,
      mode: job.mode,
      scale: job.scale,
      locale: job.locale,
      type: job.type,
      quality: job.quality,
      fonts: job.fonts.map((f) => ({
        family: f.family,
        weight: f.weight,
        style: f.style,
        url: `${RENDER_ORIGIN}/f/${f.asset_id}`,
      })),
      assets: job.assets.map((a) => ({
        id: a.id,
        url: `${RENDER_ORIGIN}/a/${a.id}`,
        ...(a.crop ? { crop: a.crop } : {}),
      })),
    };

    return this.host.withBrowser(async (browser) => {
      const context: BrowserContext = await browser.newContext({
        javaScriptEnabled: true,
        serviceWorkers: 'block',
        acceptDownloads: false,
        viewport: { width: 64, height: 64 },
      });
      try {
        await context.route('**/*', (route: Route) =>
          fulfilFromMemory(route, served),
        );
        const page = await context.newPage();
        page.setDefaultTimeout(timeoutMs);
        const work = (async () => {
          await page.goto(RENDER_PAGE_URL, { waitUntil: 'load' });
          const out = (await page.evaluate(
            (j) =>
              (
                window as unknown as {
                  __render: (x: unknown) => Promise<unknown>;
                }
              ).__render(j),
            pageJob,
          )) as {
            data: string;
            width: number;
            height: number;
            report: RenderReport;
          };
          return {
            data: Buffer.from(out.data, 'base64'),
            width: out.width,
            height: out.height,
            report: out.report,
          };
        })();
        return await withTimeout(work, timeoutMs, 'Designer render');
      } finally {
        await this.closeContext(context);
      }
    }, lane);
  }

  /**
   * Closes a job's context within CONTEXT_CLOSE_TIMEOUT_MS. A close that
   * hangs (renderer stuck after a timed-out job) takes the whole browser
   * down instead, so the lane is freed and the next job relaunches.
   */
  private async closeContext(context: Pick<BrowserContext, 'close'>) {
    try {
      await withTimeout(
        context.close(),
        CONTEXT_CLOSE_TIMEOUT_MS,
        'Designer context close',
      );
    } catch (e) {
      this.logger.warn(
        `Designer render context did not close, closing the browser: ${String((e as Error)?.message ?? e)}`,
      );
      await this.host.close();
    }
  }

  close(): Promise<void> {
    return this.host.close();
  }
}

/** Serves `https://designer.invalid/<path>` from memory; aborts the rest. */
export async function fulfilFromMemory(
  route: Route,
  served: Map<string, RenderFile>,
): Promise<void> {
  const url = route.request().url();
  const prefix = `${RENDER_ORIGIN}/`;
  const file = url.startsWith(prefix)
    ? served.get(url.slice(prefix.length).split(/[?#]/)[0])
    : undefined;
  if (!file) {
    await route.abort('blockedbyclient').catch(() => undefined);
    return;
  }
  await route
    .fulfill({
      status: 200,
      body: file.body,
      headers: {
        'content-type': file.contentType,
        'cache-control': 'no-store',
      },
    })
    .catch(() => undefined);
}

/** `DESIGNER_RENDER_ENGINE=off`: every render is unavailable, no browser ever starts. */
export class DisabledDesignerRenderer implements DesignerBrowserRenderer {
  readonly enabled = false;

  renderCanvas(): Promise<CanvasResult> {
    return Promise.reject(
      new DesignerRenderUnavailableError(
        'Design rendering is disabled (DESIGNER_RENDER_ENGINE=off)',
      ),
    );
  }

  probe(): Promise<void> {
    return Promise.reject(
      new DesignerRenderUnavailableError(
        'Design rendering is disabled (DESIGNER_RENDER_ENGINE=off)',
      ),
    );
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const OFF_VALUES = ['off', 'disabled', 'none', 'false', '0'];

/** True when an env flag holds one of the "off" spellings. */
export function isOffFlag(value: string | undefined): boolean {
  return OFF_VALUES.includes(
    String(value ?? '')
      .trim()
      .toLowerCase(),
  );
}

/**
 * Picks the designer renderer from the environment:
 *   DESIGNER_RENDER_ENGINE=off|disabled|none → DisabledDesignerRenderer
 *   anything else (default 'chromium')       → DesignerChromiumHost
 */
export function createDesignerRenderer(
  env: NodeJS.ProcessEnv = process.env,
): DesignerBrowserRenderer {
  if (isOffFlag(env.DESIGNER_RENDER_ENGINE)) {
    return new DisabledDesignerRenderer();
  }
  const pick = (...vals: (string | undefined)[]) =>
    vals.map((v) => v?.trim()).find((v) => !!v) || undefined;
  return new DesignerChromiumHost({
    printConcurrency: Number(env.DESIGNER_RENDER_CONCURRENCY) === 2 ? 2 : 1,
    executablePath: pick(
      env.DESIGNER_CHROMIUM_PATH,
      env.INVOICE_PDF_CHROMIUM_PATH,
    ),
    channel: pick(
      env.DESIGNER_BROWSER_CHANNEL,
      env.INVOICE_PDF_BROWSER_CHANNEL,
    ),
  });
}
