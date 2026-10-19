/*
 * Web ↔ server parity of the designer renderer (M4.2 WP11, §12.3 G1 on the
 * draw-call level).
 *
 * Server path, end-to-end without a browser: DesignerRenderService.renderCanvas
 * → DesignerChromiumHost.renderCanvas (real job building and real in-memory
 * routing via fulfilFromMemory) → the served `renderer.js` + `page.js` bytes
 * executed in a Node vm with fake DOM primitives (FontFace, fetch,
 * createImageBitmap, canvas) → window.__render → renderDesign on a recording
 * Ctx2D.
 *
 * Web path: the ESM build of `@multi-stores/core/designer` (what the web
 * bundles), transpiled to CommonJS and evaluated in a vm, called with the exact input
 * shape of `DesignerCanvas.tsx` (no font lookup, `uiFontFamily: 'system-ui'`).
 *
 * Both must produce the same draw-call log as each other and as the stored
 * goldens of `design-renderer.golden.spec.ts` for every template and case.
 */
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import * as ts from 'typescript';
import type { Browser } from 'playwright-core';
import { DesignerRenderService } from '../designer-render.service';
import {
  caseInput,
  fakeImage,
  GOLDEN_CASES,
  GOLDEN_DIR,
  logHash,
  loadTemplate,
  RecordingCtx,
  specAssetIds,
  TEMPLATE_IDS,
  PHOTO_LANDSCAPE,
  PHOTO_PORTRAIT,
  type GoldenRecord,
} from '../__fixtures__/golden/golden-kit.mockspec';
import * as apiRenderer from '@multi-stores/core/designer';
import type {
  Ctx2D,
  RenderInput,
  RenderReport,
  TemplateSpecV1,
} from '@multi-stores/core/designer';
import { DesignerChromiumHost } from './designer-chromium.host';
import { RENDER_ORIGIN } from './render-page';

type RendererModule = typeof apiRenderer;

const STORE = '11111111-1111-4111-8111-111111111111';
// The web bundles the ESM build of @multi-stores/core/designer (M5.3); the
// server serves the CommonJS build. Both are loaded from the package here.
const CORE_DIR = path.dirname(require.resolve('@multi-stores/core/package.json'));
const WEB_MIRROR = path.join(CORE_DIR, 'dist/esm/designer/design-renderer.js');
const SERVER_BUILD = require.resolve('@multi-stores/core/designer');

/** Transpiles a renderer source file and evaluates it in a fresh vm realm. */
function loadRendererSource(file: string): RendererModule {
  const out = ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
    },
  }).outputText;
  const module = { exports: {} as Record<string, unknown> };
  vm.runInNewContext(out, { module, exports: module.exports });
  return module.exports as unknown as RendererModule;
}

/* ------------------------------------------------------------------ */
/* Fake browser: runs the served page bytes in a vm                    */
/* ------------------------------------------------------------------ */

type RouteHandler = (route: unknown) => Promise<void>;

/** Requests a URL through the context's route handler (the host's in-memory server). */
async function request(
  handler: RouteHandler,
  url: string,
): Promise<Buffer | null> {
  let body: Buffer | null = null;
  const route = {
    request: () => ({ url: () => url }),
    fulfill: (r: { body: Buffer }) => {
      body = r.body;
      return Promise.resolve();
    },
    abort: () => Promise.resolve(),
  };
  await handler(route);
  return body;
}

interface PageRun {
  ctx: RecordingCtx;
  served: string[];
}

function fakeBrowser(runs: PageRun[]): Browser {
  return {
    newContext: () => {
      let handler: RouteHandler | null = null;
      const context = {
        route: (_p: string, h: RouteHandler) => {
          handler = h;
          return Promise.resolve();
        },
        close: () => Promise.resolve(),
        newPage: () => {
          let sandbox: Record<string, unknown> | null = null;
          const run: PageRun = { ctx: new RecordingCtx(), served: [] };
          const get = async (url: string) => {
            const b = await request(handler!, url);
            if (b) run.served.push(url.slice(RENDER_ORIGIN.length + 1));
            return b;
          };
          return Promise.resolve({
            setDefaultTimeout: () => undefined,
            goto: async (url: string) => {
              const html = (await get(url))!.toString('utf8');
              const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map(
                (m) => m[1],
              );
              sandbox = makeSandbox(run, get);
              for (const src of scripts) {
                const code = await get(RENDER_ORIGIN + src);
                if (!code) throw new Error('script not served: ' + src);
                vm.runInContext(code.toString('utf8'), sandbox);
              }
            },
            evaluate: (_fn: unknown, job: unknown) => {
              runs.push(run);
              return (
                sandbox!.__render as (j: unknown) => Promise<unknown>
              )(job);
            },
          });
        },
      };
      return Promise.resolve(context);
    },
  } as unknown as Browser;
}

function makeSandbox(
  run: PageRun,
  get: (url: string) => Promise<Buffer | null>,
): vm.Context {
  class FontFace {
    constructor(
      readonly family: string,
      readonly src: string,
      readonly desc: unknown,
    ) {}
    async load() {
      const url = /url\(([^)]+)\)/.exec(this.src)?.[1] ?? '';
      if (!(await get(url))) throw new Error('font not served');
      return this;
    }
  }
  class FileReader {
    result: string | null = null;
    error: unknown = null;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    readAsDataURL() {
      this.result = 'data:application/octet-stream;base64,AA==';
      setTimeout(() => this.onload?.(), 0);
    }
  }
  const sandbox: Record<string, unknown> = {
    FontFace,
    FileReader,
    setTimeout,
    document: {
      fonts: { add: () => undefined },
      createElement: (tag: string) => {
        if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
        return {
          width: 0,
          height: 0,
          getContext: () => run.ctx,
          toBlob: (cb: (b: unknown) => void) => cb({}),
        };
      },
    },
    fetch: async (url: string) => {
      const body = await get(url);
      const id = url.slice((RENDER_ORIGIN + '/a/').length);
      return {
        ok: !!body,
        blob: () => Promise.resolve({ __asset: id }),
      };
    },
    createImageBitmap: (blob: { __asset: string }) =>
      Promise.resolve({ ...fakeImage(blob.__asset), close: () => undefined }),
  };
  sandbox.window = sandbox;
  return vm.createContext(sandbox);
}

/* ------------------------------------------------------------------ */
/* Server render service with in-memory assets and fonts               */
/* ------------------------------------------------------------------ */

function serverService(spec: TemplateSpecV1, runs: PageRun[]) {
  const host = new DesignerChromiumHost();
  (host.host as unknown as { withBrowser: unknown }).withBrowser = (
    fn: (b: Browser) => Promise<unknown>,
  ) => fn(fakeBrowser(runs));
  const ids = [...specAssetIds(spec), PHOTO_LANDSCAPE, PHOTO_PORTRAIT];
  const rows = ids.map((id) => ({
    id,
    store_id: STORE,
    kind: id.startsWith('photo') ? 'CUSTOMER_PHOTO' : 'TEMPLATE_BG_WEB',
    private_key: `k/${id}`,
    preview_key: null,
    mime: 'image/png',
    // 1×1 rows: prepareImage never resamples, so bytes stay opaque.
    width: 1,
    height: 1,
    purged_at: null,
  }));
  const prisma = {
    designAsset: {
      findMany: ({ where }: { where: { id: { in: string[] } } }) =>
        Promise.resolve(rows.filter((r) => where.id.in.includes(r.id))),
    },
  };
  const assets = {
    readAssetBytes: (a: { id: string }) => Promise.resolve(Buffer.from(a.id)),
  };
  const fonts = {
    fontFiles: (_s: string, fids: string[]) =>
      Promise.resolve(
        spec.fonts
          .filter((f) => fids.includes(f.asset_id))
          .map((f) => ({
            asset_id: f.asset_id,
            family: f.family,
            weight: f.weight,
            style: f.style,
            format: 'woff2',
            mime: 'font/woff2',
            data: Buffer.from('font:' + f.asset_id),
          })),
      ),
  };
  return new DesignerRenderService(
    prisma as never,
    {} as never,
    assets as never,
    fonts as never,
    {} as never,
    host,
  );
}

/** Golden record of a template case (as stored by the golden spec). */
function storedGolden(stem: string, key: string): GoldenRecord {
  const file = path.join(GOLDEN_DIR, 'renderer', stem + '.json');
  const g = JSON.parse(readFileSync(file, 'utf8')) as {
    cases: Record<string, GoldenRecord>;
  };
  return g.cases[key];
}

/** The input DesignerCanvas.tsx passes to renderDesign (web editor). */
function webInput(spec: TemplateSpecV1, key: string): RenderInput {
  const c = GOLDEN_CASES.find((x) => x.key === key)!;
  const base = caseInput(spec, c);
  return {
    spec,
    state: base.state,
    mode: base.mode,
    scale: base.scale,
    images: { get: (id: string) => fakeImage(id) },
    locale: base.locale,
    ui: {
      activeSlotId: base.ui?.activeSlotId,
      emptySlotText: undefined,
      uiFontFamily: 'system-ui',
    },
  };
}

function record(
  render: (ctx: Ctx2D, input: RenderInput) => RenderReport,
  input: RenderInput,
) {
  const ctx = new RecordingCtx();
  const report = render(ctx, input);
  return { ctx, report: JSON.parse(JSON.stringify(report)) as RenderReport };
}

describe('renderer parity: web mirror ↔ server render path (draw-call logs)', () => {
  // Always present (package dependency); a missing build must fail loudly.
  expect(existsSync(WEB_MIRROR)).toBe(true);
  const web: RendererModule | null = loadRendererSource(WEB_MIRROR);
  const apiInVm = loadRendererSource(SERVER_BUILD);

  it('the web mirror is the same renderer version', () => {
    if (!web) return; // sibling repo not checked out
    expect(web.RENDERER_VERSION).toBe(apiRenderer.RENDERER_VERSION);
  });

  describe.each(TEMPLATE_IDS)('%s', (stem) => {
    const spec = loadTemplate(stem);

    it.each(GOLDEN_CASES.filter((c) => c.mode !== 'edit').map((c) => c.key))(
      'server path %s = golden = web mirror',
      async (key) => {
        const c = GOLDEN_CASES.find((x) => x.key === key)!;
        const runs: PageRun[] = [];
        const service = serverService(spec, runs);
        const state = caseInput(spec, c).state;
        const result = await service.renderCanvas(STORE, spec, state, {
          mode: c.mode as 'proof' | 'print',
          scale: c.scale,
          type: c.mode === 'print' ? 'image/png' : 'image/webp',
          timeoutMs: 5_000,
        });
        expect(runs).toHaveLength(1);
        const server = runs[0];
        // The page loaded the renderer + page script and only job files.
        expect(server.served.slice(0, 3)).toEqual([
          'render.html',
          'renderer.js',
          'page.js',
        ]);
        const size = apiRenderer.canvasSize(spec, c.scale);
        expect([result.width, result.height]).toEqual([
          size.width,
          size.height,
        ]);

        const gold = storedGolden(stem, key);
        const serverLog = server.ctx.normalizedLog();
        expect(logHash(serverLog)).toBe(gold.sha256);
        expect(JSON.parse(JSON.stringify(result.report))).toEqual(gold.report);

        // Pure api renderer (same realm as the specs) — raw, unrounded logs.
        const pure = record(apiRenderer.renderDesign, caseInput(spec, c));
        expect(server.ctx.log).toEqual(pure.ctx.log);

        if (web) {
          const w = record(web.renderDesign, webInput(spec, key));
          expect(w.ctx.log).toEqual(server.ctx.log);
          expect(w.report).toEqual(gold.report);
        }
      },
    );

    it.each(GOLDEN_CASES.filter((c) => c.mode === 'edit').map((c) => c.key))(
      'web editor %s = golden',
      (key) => {
        const gold = storedGolden(stem, key);
        const impl = web ?? apiInVm;
        const w = record(impl.renderDesign, webInput(spec, key));
        expect(logHash(w.ctx.normalizedLog())).toBe(gold.sha256);
      },
    );
  });

  it('the bundle served to Chromium is the transpiled renderer.ts (same draw log as the api import)', () => {
    const spec = loadTemplate('template_4308');
    const c = GOLDEN_CASES[0];
    const a = record(apiRenderer.renderDesign, caseInput(spec, c));
    const b = record(apiInVm.renderDesign, caseInput(spec, c));
    expect(b.ctx.log).toEqual(a.ctx.log);
  });
});
