/**
 * Public surface of the invoice PDF engine. InvoicesModule spreads
 * INVOICE_PDF_PROVIDERS into its `providers` (InvoicesModule imports only
 * globals, PrismaService included).
 *
 * Environment:
 *   INVOICE_PDF_ENGINE            chromium (default) | off
 *   INVOICE_PDF_CHROMIUM_PATH     explicit browser executable
 *   INVOICE_PDF_BROWSER_CHANNEL   msedge | chrome | chromium ... (dev)
 *   INVOICE_STORAGE_DIR           default <cwd>/storage/invoices
 */
import type { Provider } from '@nestjs/common';
import {
  INVOICE_STORAGE,
  LocalDiskInvoiceStorage,
} from '../storage/invoice-storage';
import { createPdfRenderer } from './chromium.renderer';
import { InvoicePdfService } from './invoice-pdf.service';
import { PDF_RENDERER } from './pdf-renderer';

export const INVOICE_PDF_PROVIDERS: Provider[] = [
  { provide: PDF_RENDERER, useFactory: () => createPdfRenderer(process.env) },
  {
    provide: INVOICE_STORAGE,
    useFactory: () =>
      new LocalDiskInvoiceStorage(process.env.INVOICE_STORAGE_DIR),
  },
  InvoicePdfService,
];

export {
  InvoicePdfService,
  invoicePdfFilename,
  loadLogoDataUri,
  type InvoicePdf,
} from './invoice-pdf.service';
export {
  PDF_RENDERER,
  PdfUnavailableError,
  DisabledPdfRenderer,
  type PdfRenderer,
} from './pdf-renderer';
export { ChromiumPdfRenderer, createPdfRenderer } from './chromium.renderer';
export {
  renderInvoiceHtml,
  renderInvoiceFooterHtml,
  shouldShowBankBox,
  esc,
} from './invoice-template';
export {
  INVOICE_PHRASES,
  PDF_LOCALES,
  getInvoicePhrases,
  resolvePdfLocale,
  type InvoicePhrases,
} from './invoice-phrases';
export { toSnapshotForPdf, type SnapshotForPdf } from './snapshot-for-pdf';
export {
  INVOICE_STORAGE,
  LocalDiskInvoiceStorage,
  type InvoiceStorage,
} from '../storage/invoice-storage';
