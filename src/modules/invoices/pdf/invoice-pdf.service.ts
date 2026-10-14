/**
 * Lazily renders and stores invoice PDFs (D7, D8, L8).
 *
 * getPdf(id):
 *   1. stored file present (pdf_path) → return it;
 *   2. otherwise render from the immutable snapshot, store it atomically and
 *      record pdf_path / pdf_sha256 / pdf_generated_at (the only Invoice
 *      columns the immutability trigger lets through).
 * Concurrent calls for the same invoice share one render.
 *
 * Throws PdfUnavailableError when the engine is off or cannot start; callers
 * map it to 503 INVOICE_PDF_UNAVAILABLE / "send the email without it".
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import * as path from 'path';
import { PrismaService } from '../../../prisma/prisma.service';
import { invoiceErrors } from '../invoice-errors';
import {
  INVOICE_STORAGE,
  type InvoiceStorage,
} from '../storage/invoice-storage';
import { getInvoiceFontCss } from './fonts';
import { getInvoicePhrases, INVOICE_PHRASES } from './invoice-phrases';
import { renderInvoiceFooterHtml, renderInvoiceHtml } from './invoice-template';
import {
  PDF_RENDERER,
  PdfUnavailableError,
  type PdfRenderer,
} from './pdf-renderer';
import { toSnapshotForPdf, type SnapshotForPdf } from './snapshot-for-pdf';

export { PdfUnavailableError } from './pdf-renderer';

export interface InvoicePdf {
  buffer: Buffer;
  filename: string;
}

const LOGO_MAX_BYTES = 2 * 1024 * 1024;
const LOGO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

/** ASCII-only slug for a Content-Disposition filename. */
function asciiSlug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** "Faktura-1001.pdf", "Kreditfaktura-CN-7.pdf", "Invoice-1001.pdf" (ar). */
export function invoicePdfFilename(
  snapshot: Pick<SnapshotForPdf, 'kind' | 'locale'>,
  number: string,
): string {
  const key = snapshot.kind === 'CREDIT_NOTE' ? 'creditNote' : 'invoice';
  const label =
    asciiSlug(getInvoicePhrases(snapshot.locale)[key]) ||
    asciiSlug(INVOICE_PHRASES.en[key]);
  return `${label}-${asciiSlug(number) || 'document'}.pdf`;
}

/**
 * Reads a public logo from `<cwd>/uploads` as a data URI. Accepts
 * "/uploads/..." paths and absolute URLs whose path is /uploads/... (the file
 * is read locally; nothing is fetched). Anything else → null.
 */
export async function loadLogoDataUri(
  logoUrl: string | null | undefined,
  uploadsRoot = path.join(process.cwd(), 'uploads'),
): Promise<string | null> {
  if (!logoUrl) return null;
  const raw = logoUrl.trim();
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(raw)) {
    return raw.length <= LOGO_MAX_BYTES * 1.4 ? raw : null;
  }
  let pathname = raw;
  if (/^https?:\/\//i.test(raw)) {
    try {
      pathname = new URL(raw).pathname;
    } catch {
      return null;
    }
  }
  if (!pathname.startsWith('/uploads/')) return null;
  let rel: string;
  try {
    rel = decodeURIComponent(pathname.slice('/uploads/'.length));
  } catch {
    return null;
  }
  const root = path.resolve(uploadsRoot);
  const file = path.resolve(root, rel);
  const inside = path.relative(root, file);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) {
    return null;
  }
  const mime = LOGO_MIME[path.extname(file).toLowerCase()];
  if (!mime) return null;
  try {
    const st = await fs.stat(file);
    if (!st.isFile() || st.size > LOGO_MAX_BYTES) return null;
    const data = await fs.readFile(file);
    return `data:${mime};base64,${data.toString('base64')}`;
  } catch {
    return null;
  }
}

@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name);
  private readonly inflight = new Map<string, Promise<InvoicePdf>>();

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PDF_RENDERER) private readonly renderer: PdfRenderer,
    @Inject(INVOICE_STORAGE) private readonly storage: InvoiceStorage,
  ) {}

  getPdf(invoiceId: string): Promise<InvoicePdf> {
    const running = this.inflight.get(invoiceId);
    if (running) return running;
    const p = this.load(invoiceId).finally(() =>
      this.inflight.delete(invoiceId),
    );
    this.inflight.set(invoiceId, p);
    return p;
  }

  /** Renders a snapshot without touching storage (previews, smoke tests). */
  async renderSnapshot(stored: unknown): Promise<Buffer> {
    const snap = toSnapshotForPdf(stored);
    const phrases = getInvoicePhrases(snap.locale);
    const fontCss = getInvoiceFontCss();
    const logoDataUri = await loadLogoDataUri(snap.seller.logo_url);
    const html = renderInvoiceHtml(snap, phrases, { fontCss, logoDataUri });
    const footer = renderInvoiceFooterHtml(snap, phrases, { fontCss });
    return this.renderer.render(html, footer);
  }

  private async load(invoiceId: string): Promise<InvoicePdf> {
    const row = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: {
        id: true,
        store_id: true,
        kind: true,
        number: true,
        issue_date: true,
        locale: true,
        snapshot: true,
        pdf_path: true,
      },
    });
    if (!row) throw invoiceErrors.notFound();

    const filename = invoicePdfFilename(
      { kind: row.kind, locale: row.locale },
      row.number,
    );

    if (row.pdf_path) {
      try {
        const stored = await this.storage.read(row.pdf_path);
        if (stored && stored.length > 0) return { buffer: stored, filename };
      } catch (e) {
        this.logger.warn(
          `Stored PDF for invoice ${row.id} unreadable (${String(e)}); regenerating`,
        );
      }
    }

    let buffer: Buffer;
    try {
      buffer = await this.renderSnapshot(row.snapshot);
    } catch (e) {
      if (e instanceof PdfUnavailableError) throw e;
      this.logger.error(
        `Rendering PDF for invoice ${row.id} failed: ${String(e)}`,
      );
      throw new PdfUnavailableError('PDF render failed', { cause: e });
    }

    const key = this.storage.keyFor(row.store_id, row.issue_date, row.id);
    try {
      await this.storage.write(key, buffer);
      await this.prisma.invoice.update({
        where: { id: row.id },
        data: {
          pdf_path: key,
          pdf_sha256: createHash('sha256').update(buffer).digest('hex'),
          pdf_generated_at: new Date(),
        },
      });
    } catch (e) {
      // The PDF is still valid for this request; the next call retries the store.
      this.logger.error(
        `Storing PDF for invoice ${row.id} failed: ${String(e)}`,
      );
    }
    return { buffer, filename };
  }
}
