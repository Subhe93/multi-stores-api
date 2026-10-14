import { NotFoundException } from '@nestjs/common';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { PrismaService } from '../../../prisma/prisma.service';
import type { InvoiceStorage } from '../storage/invoice-storage';
import { InvoicePdfService, loadLogoDataUri } from './invoice-pdf.service';
import { PdfUnavailableError, type PdfRenderer } from './pdf-renderer';
import { sampleSvCompanyInvoice } from './testing/sample-snapshots';

const ROW = {
  id: 'inv-1',
  store_id: 'store-1',
  kind: 'INVOICE' as const,
  number: '1001',
  issue_date: new Date('2026-10-14T00:00:00Z'),
  locale: 'sv',
  snapshot: sampleSvCompanyInvoice(),
  pdf_path: null as string | null,
};

interface PdfUpdateArgs {
  where: { id: string };
  data: { pdf_path: string; pdf_sha256: string; pdf_generated_at: Date };
}

function setup(row: typeof ROW | null = { ...ROW }) {
  const update = jest.fn<Promise<unknown>, [PdfUpdateArgs]>(() =>
    Promise.resolve({}),
  );
  const prisma = {
    invoice: { findUnique: jest.fn(() => Promise.resolve(row)), update },
  };
  const render = jest.fn<Promise<Buffer>, [string, string]>(() =>
    Promise.resolve(Buffer.from('%PDF-1.7 rendered')),
  );
  const renderer: PdfRenderer = { render };
  const files = new Map<string, Buffer>();
  const write = jest.fn<Promise<void>, [string, Buffer]>((k, b) => {
    files.set(k, b);
    return Promise.resolve();
  });
  const storage: InvoiceStorage = {
    keyFor: (s: string, d: Date | string, id: string) =>
      `${s}/${new Date(d).getUTCFullYear()}/${id}.pdf`,
    exists: (k: string) => Promise.resolve(files.has(k)),
    read: (k: string) => Promise.resolve(files.get(k) ?? null),
    write,
  };
  const service = new InvoicePdfService(
    prisma as unknown as PrismaService,
    renderer,
    storage,
  );
  return { update, render, write, files, service };
}

describe('InvoicePdfService.getPdf', () => {
  it('renders, stores and records the PDF on first request', async () => {
    const { service, render, write, update } = setup();
    const out = await service.getPdf('inv-1');
    expect(out.filename).toBe('Faktura-1001.pdf');
    expect(out.buffer.toString()).toBe('%PDF-1.7 rendered');
    expect(render).toHaveBeenCalledTimes(1);
    const [html, footer] = render.mock.calls[0];
    expect(html).toContain('<html lang="sv"');
    expect(html).toContain('@font-face');
    expect(footer).toContain('pageNumber');
    expect(write).toHaveBeenCalledWith('store-1/2026/inv-1.pdf', out.buffer);
    const data = update.mock.calls[0][0].data;
    expect(data.pdf_path).toBe('store-1/2026/inv-1.pdf');
    expect(data.pdf_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(data.pdf_generated_at).toBeInstanceOf(Date);
  });

  it('returns the stored file without rendering', async () => {
    const { service, render, files, update } = setup({
      ...ROW,
      pdf_path: 'store-1/2026/inv-1.pdf',
    });
    files.set('store-1/2026/inv-1.pdf', Buffer.from('%PDF-stored'));
    const out = await service.getPdf('inv-1');
    expect(out.buffer.toString()).toBe('%PDF-stored');
    expect(render).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('regenerates when the stored file is missing', async () => {
    const { service, render } = setup({
      ...ROW,
      pdf_path: 'store-1/2026/inv-1.pdf',
    });
    await service.getPdf('inv-1');
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('shares one render between concurrent calls', async () => {
    const { service, render } = setup();
    const [a, b] = await Promise.all([
      service.getPdf('inv-1'),
      service.getPdf('inv-1'),
    ]);
    expect(a).toBe(b);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('propagates PdfUnavailableError and stores nothing', async () => {
    const { service, render, write, update } = setup();
    render.mockRejectedValue(new PdfUnavailableError());
    await expect(service.getPdf('inv-1')).rejects.toBeInstanceOf(
      PdfUnavailableError,
    );
    expect(write).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('maps unexpected render errors to PdfUnavailableError', async () => {
    const { service, render } = setup();
    render.mockRejectedValue(new Error('timed out'));
    await expect(service.getPdf('inv-1')).rejects.toBeInstanceOf(
      PdfUnavailableError,
    );
  });

  it('still returns the PDF when storing it fails', async () => {
    const { service, write } = setup();
    write.mockRejectedValue(new Error('disk full'));
    const out = await service.getPdf('inv-1');
    expect(out.buffer.toString()).toBe('%PDF-1.7 rendered');
  });

  it('404s an unknown invoice', async () => {
    const { service } = setup(null);
    await expect(service.getPdf('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

describe('loadLogoDataUri', () => {
  let uploads: string;

  beforeAll(async () => {
    uploads = await fs.mkdtemp(path.join(os.tmpdir(), 'inv-logo-'));
    await fs.mkdir(path.join(uploads, 'general'));
    await fs.writeFile(path.join(uploads, 'general', 'logo.png'), 'PNGDATA');
    await fs.writeFile(path.join(uploads, 'secret.txt'), 'nope');
  });

  afterAll(() => fs.rm(uploads, { recursive: true, force: true }));

  it('reads /uploads/ paths and same-path URLs as data URIs', async () => {
    const expected = `data:image/png;base64,${Buffer.from('PNGDATA').toString('base64')}`;
    expect(await loadLogoDataUri('/uploads/general/logo.png', uploads)).toBe(
      expected,
    );
    expect(
      await loadLogoDataUri(
        'https://api.example.com/uploads/general/logo.png',
        uploads,
      ),
    ).toBe(expected);
  });

  it('rejects traversal, other paths and non-images', async () => {
    expect(
      await loadLogoDataUri('/uploads/../package.json', uploads),
    ).toBeNull();
    expect(
      await loadLogoDataUri('/uploads/%2e%2e/package.json', uploads),
    ).toBeNull();
    expect(await loadLogoDataUri('/uploads/secret.txt', uploads)).toBeNull();
    expect(await loadLogoDataUri('/etc/passwd', uploads)).toBeNull();
    expect(await loadLogoDataUri('/uploads/missing.png', uploads)).toBeNull();
    expect(await loadLogoDataUri(null, uploads)).toBeNull();
  });
});
