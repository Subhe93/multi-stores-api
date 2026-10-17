import * as vm from 'vm';
import {
  CONTEXT_CLOSE_TIMEOUT_MS,
  createDesignerRenderer,
  DesignerChromiumHost,
  DesignerRenderUnavailableError,
  DisabledDesignerRenderer,
  fulfilFromMemory,
  isOffFlag,
} from './designer-chromium.host';
import { RENDER_PAGE_SCRIPT, rendererBundle } from './render-page';
import { RENDERER_VERSION } from './design-renderer';

describe('createDesignerRenderer (env)', () => {
  it('DESIGNER_RENDER_ENGINE=off → disabled, never launches', async () => {
    const r = createDesignerRenderer({ DESIGNER_RENDER_ENGINE: 'off' });
    expect(r).toBeInstanceOf(DisabledDesignerRenderer);
    expect(r.enabled).toBe(false);
    await expect(
      r.renderCanvas({} as never, new Map(), 1000),
    ).rejects.toBeInstanceOf(DesignerRenderUnavailableError);
  });

  it('defaults to Chromium; designer path/channel fall back to the invoice ones', () => {
    const own = createDesignerRenderer({
      DESIGNER_CHROMIUM_PATH: '/d/chrome',
      INVOICE_PDF_CHROMIUM_PATH: '/i/chrome',
    }) as DesignerChromiumHost;
    expect(own).toBeInstanceOf(DesignerChromiumHost);
    const opts = (o: DesignerChromiumHost) =>
      (o.host as unknown as { opts: Record<string, unknown> }).opts;
    expect(opts(own).executablePath).toBe('/d/chrome');
    const fallback = createDesignerRenderer({
      INVOICE_PDF_BROWSER_CHANNEL: 'msedge',
    }) as DesignerChromiumHost;
    expect(opts(fallback).channel).toBe('msedge');
    // Separate proof / print lanes (one slot each by default).
    expect(opts(fallback).lanes).toEqual({
      proof: { concurrency: 1, maxQueue: 8, acquireTimeoutMs: 5000 },
      print: { concurrency: 1, maxQueue: 4, acquireTimeoutMs: 60000 },
    });
    const two = createDesignerRenderer({
      DESIGNER_RENDER_CONCURRENCY: '2',
    }) as DesignerChromiumHost;
    expect(
      (opts(two).lanes as Record<string, { concurrency: number }>).print
        .concurrency,
    ).toBe(2);
    expect(opts(fallback).args).toEqual(
      expect.arrayContaining(['--disable-gpu', '--force-color-profile=srgb']),
    );
    expect(fallback.launchCount).toBe(0); // nothing launches at construction
  });

  it('isOffFlag', () => {
    expect(
      ['off', 'OFF', ' disabled ', 'none', 'false', '0'].every(isOffFlag),
    ).toBe(true);
    expect([undefined, '', 'on', 'chromium'].some(isOffFlag)).toBe(false);
  });

  it('a browser that cannot launch → DesignerRenderUnavailableError (503)', async () => {
    const host = new DesignerChromiumHost({
      executablePath: '/definitely/not/a/browser',
      timeoutMs: 5000,
    });
    const err = await host
      .renderCanvas({ fonts: [], assets: [] } as never, new Map(), 1000)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DesignerRenderUnavailableError);
    expect((err as DesignerRenderUnavailableError).getStatus()).toBe(503);
    await host.close();
  });
});

describe('DesignerChromiumHost admission', () => {
  const spec = (w: number, h: number) =>
    ({
      width: w,
      height: h,
      bleed_mm: 0,
      surfaces: [],
    }) as never;

  it('refuses an oversized canvas before touching the browser', async () => {
    const host = new DesignerChromiumHost({
      executablePath: '/definitely/not/a/browser',
    });
    const err = await host
      .renderCanvas(
        {
          spec: spec(5000, 5000),
          scale: 6,
          mode: 'print',
          fonts: [],
          assets: [],
        } as never,
        new Map(),
        1000,
      )
      .catch((e: unknown) => e);
    expect(String((err as Error).message)).toMatch(/^CANVAS_TOO_LARGE:/);
    expect(host.launchCount).toBe(0);
  });

  it('a full proof lane answers 503 at once; print keeps its own slot', async () => {
    const host = new DesignerChromiumHost({
      proofLane: { maxQueue: 0, acquireTimeoutMs: 50 },
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fakeBrowser = { isConnected: () => true } as never;
    (
      host.host as unknown as { getBrowser: () => Promise<unknown> }
    ).getBrowser = () => Promise.resolve(fakeBrowser);
    const first = host.host.withBrowser(() => gate, 'proof');
    const second = await host.host
      .withBrowser(() => Promise.resolve(1), 'proof')
      .catch((e: unknown) => e);
    expect(second).toBeInstanceOf(DesignerRenderUnavailableError);
    expect((second as DesignerRenderUnavailableError).getStatus()).toBe(503);
    // The print lane is independent of the busy proof lane.
    await expect(
      host.host.withBrowser(() => Promise.resolve('print'), 'print'),
    ).resolves.toBe('print');
    release();
    await first;
    await host.close();
  });
});

describe('DesignerChromiumHost context close', () => {
  afterEach(() => jest.useRealTimers());

  /** A fake browser whose page renders at once but whose context never closes. */
  function hungBrowser(closeCalls: { n: number }) {
    return {
      isConnected: () => true,
      newContext: () =>
        Promise.resolve({
          route: () => Promise.resolve(),
          newPage: () =>
            Promise.resolve({
              setDefaultTimeout: () => undefined,
              goto: () => Promise.resolve(),
              evaluate: () =>
                Promise.resolve({
                  data: Buffer.from('png').toString('base64'),
                  width: 1,
                  height: 1,
                  report: { fitted: {}, missing: [], elements: 0 },
                }),
            }),
          close: () => {
            closeCalls.n++;
            return new Promise<void>(() => undefined); // never settles
          },
        }),
    } as never;
  }

  it('a context.close() that never settles is abandoned after CONTEXT_CLOSE_TIMEOUT_MS and the browser is closed, so the lane frees', async () => {
    jest.useFakeTimers();
    const host = new DesignerChromiumHost();
    const closeCalls = { n: 0 };
    const browser = hungBrowser(closeCalls);
    Object.assign(host.host, {
      browser,
      getBrowser: () => Promise.resolve(browser),
    });
    const browserClose = jest
      .spyOn(host.host, 'close')
      .mockImplementation(() => Promise.resolve());
    const job = host.renderCanvas(
      { spec: null, mode: 'print', fonts: [], assets: [] } as never,
      new Map(),
      60_000,
    );
    let settled = false;
    void job.then(() => (settled = true));
    await jest.advanceTimersByTimeAsync(CONTEXT_CLOSE_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    expect(closeCalls.n).toBe(1);
    await jest.advanceTimersByTimeAsync(2);
    await job;
    expect(browserClose).toHaveBeenCalledTimes(1);
    // The print lane slot was released: a second job runs at once.
    expect(host.host.laneBusy('print')).toBe(0);
  });

  it('a page that hangs past the job timeout fails the job and still closes the context', async () => {
    jest.useFakeTimers();
    const host = new DesignerChromiumHost();
    let closed = 0;
    const browser = {
      isConnected: () => true,
      newContext: () =>
        Promise.resolve({
          route: () => Promise.resolve(),
          newPage: () =>
            Promise.resolve({
              setDefaultTimeout: () => undefined,
              goto: () => Promise.resolve(),
              evaluate: () => new Promise(() => undefined), // hangs
            }),
          close: () => {
            closed++;
            return Promise.resolve();
          },
        }),
    } as never;
    Object.assign(host.host, {
      browser,
      getBrowser: () => Promise.resolve(browser),
    });
    const job = host
      .renderCanvas(
        { spec: null, mode: 'print', fonts: [], assets: [] } as never,
        new Map(),
        1_000,
      )
      .catch((e: Error) => e);
    await jest.advanceTimersByTimeAsync(1_001);
    const err = await job;
    expect(String((err as Error).message)).toMatch(/timed out after 1000 ms/);
    expect(closed).toBe(1);
    expect(host.host.laneBusy('print')).toBe(0);
  });
});

describe('fulfilFromMemory (network isolation)', () => {
  const route = (url: string) => ({
    request: () => ({ url: () => url }),
    abort: jest.fn(() => Promise.resolve()),
    fulfill: jest.fn(() => Promise.resolve()),
  });
  const served = new Map([
    ['a/x', { body: Buffer.from('img'), contentType: 'image/png' }],
  ]);

  it('serves known in-memory paths of https://designer.invalid', async () => {
    const r = route('https://designer.invalid/a/x?cache=1');
    await fulfilFromMemory(r as never, served);
    expect(r.fulfill).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, body: Buffer.from('img') }),
    );
    expect(r.abort).not.toHaveBeenCalled();
  });

  it.each([
    'https://designer.invalid/a/unknown',
    'https://fonts.googleapis.com/css?family=Montserrat',
    'https://namez.se/wp-content/uploads/bg.png',
    'http://designer.invalid/a/x',
    'data:text/plain,hi',
  ])('aborts %s', async (url) => {
    const r = route(url);
    await fulfilFromMemory(r as never, served);
    expect(r.abort).toHaveBeenCalled();
    expect(r.fulfill).not.toHaveBeenCalled();
  });
});

describe('render page assets', () => {
  it('the renderer bundle defines window.DesignRenderer (the mirrored file, transpiled)', () => {
    const window: Record<string, unknown> = {};
    vm.runInNewContext(rendererBundle(), { window });
    const R = window.DesignRenderer as Record<string, unknown>;
    expect(R.RENDERER_VERSION).toBe(RENDERER_VERSION);
    expect(typeof R.renderDesign).toBe('function');
    expect(typeof R.canvasSize).toBe('function');
  });

  it('the page script defines window.__render and has no network or HTML sinks', () => {
    const window: Record<string, unknown> = {};
    vm.runInNewContext(RENDER_PAGE_SCRIPT, { window });
    expect(typeof window.__render).toBe('function');
    expect(RENDER_PAGE_SCRIPT).not.toMatch(
      /innerHTML|document\.write|XMLHttpRequest|http:\/\//,
    );
  });
});
