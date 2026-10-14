import { ChromiumPdfRenderer, createPdfRenderer } from './chromium.renderer';
import { getInvoiceFontCss } from './fonts';
import { getInvoicePhrases } from './invoice-phrases';
import { renderInvoiceFooterHtml, renderInvoiceHtml } from './invoice-template';
import { DisabledPdfRenderer, PdfUnavailableError } from './pdf-renderer';
import { toSnapshotForPdf } from './snapshot-for-pdf';
import {
  sampleArPersonInvoice,
  sampleSvCompanyInvoice,
} from './testing/sample-snapshots';

describe('createPdfRenderer', () => {
  it('INVOICE_PDF_ENGINE=off is always unavailable', async () => {
    const r = createPdfRenderer({ INVOICE_PDF_ENGINE: 'off' });
    expect(r).toBeInstanceOf(DisabledPdfRenderer);
    await expect(r.render('<p>x</p>', '')).rejects.toBeInstanceOf(
      PdfUnavailableError,
    );
  });

  it('defaults to Chromium', () => {
    expect(createPdfRenderer({})).toBeInstanceOf(ChromiumPdfRenderer);
  });

  it('a browser that cannot launch → PdfUnavailableError (and is not retried at once)', async () => {
    const r = new ChromiumPdfRenderer({
      executablePath: '/definitely/not/a/browser',
      timeoutMs: 5000,
    });
    await expect(r.render('<p>x</p>', '')).rejects.toBeInstanceOf(
      PdfUnavailableError,
    );
    await expect(r.render('<p>x</p>', '')).rejects.toThrow(/recent failure/);
    expect(r.launchCount).toBe(0);
    await r.close();
  });
});

describe('font CSS', () => {
  it('embeds Noto Sans and Noto Sans Arabic as base64 woff2', () => {
    const css = getInvoiceFontCss();
    expect(css).toContain("font-family:'Noto Sans'");
    expect(css).toContain("font-family:'Noto Sans Arabic'");
    expect(css).toContain('data:font/woff2;base64,');
    expect(css).not.toMatch(/url\((?!data:)/);
  });
});

// Real-browser smoke test: INVOICE_PDF_SMOKE=1 npx jest chromium.renderer
// (uses INVOICE_PDF_CHROMIUM_PATH / INVOICE_PDF_BROWSER_CHANNEL, else Edge /
// Chrome on Windows, else Playwright's managed browser).
const smoke = process.env.INVOICE_PDF_SMOKE === '1' ? describe : describe.skip;

smoke('ChromiumPdfRenderer (smoke, real browser)', () => {
  jest.setTimeout(60_000);
  const renderer = createPdfRenderer(process.env) as ChromiumPdfRenderer;
  const fontCss = getInvoiceFontCss();

  afterAll(() => renderer.close());

  const renderSample = (raw: unknown) => {
    const snap = toSnapshotForPdf(raw);
    const p = getInvoicePhrases(snap.locale);
    return renderer.render(
      renderInvoiceHtml(snap, p, { fontCss }),
      renderInvoiceFooterHtml(snap, p, { fontCss }),
    );
  };

  const pageCount = (pdf: Buffer) =>
    (pdf.toString('latin1').match(/\/Type\s*\/Page(?!s)/g) ?? []).length;

  it('renders sv and ar to real PDFs and reuses the browser', async () => {
    const svPdf = await renderSample(sampleSvCompanyInvoice());
    expect(svPdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(svPdf.length).toBeGreaterThan(5 * 1024);
    expect(pageCount(svPdf)).toBeGreaterThanOrEqual(1);

    const arPdf = await renderSample(sampleArPersonInvoice());
    expect(arPdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(arPdf.length).toBeGreaterThan(5 * 1024);
    expect(pageCount(arPdf)).toBe(1);
    expect(arPdf.toString('latin1')).toContain('NotoSansArabic');

    expect(renderer.launchCount).toBe(1);
  });

  it('paginates long invoices', async () => {
    const raw = sampleSvCompanyInvoice();
    const item = raw.lines[0];
    raw.lines = [
      ...Array.from({ length: 60 }, (_, i) => ({
        ...item,
        description: `Artikel ${i + 1}`,
      })),
      ...raw.lines.slice(1),
    ];
    const pdf = await renderSample(raw);
    expect(pageCount(pdf)).toBeGreaterThan(1);
  });
});
