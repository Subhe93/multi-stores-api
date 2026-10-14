/**
 * Engine-agnostic PDF rendering seam (D7). The Chromium implementation lives
 * in chromium.renderer.ts; a Gotenberg sidecar could implement the same
 * interface later (`INVOICE_PDF_ENGINE=gotenberg`) without touching callers.
 */

export const PDF_RENDERER = Symbol('PDF_RENDERER');

export interface PdfRenderer {
  /**
   * Renders a self-contained HTML document to an A4 PDF.
   * @param html        full document (inline CSS / fonts / images only)
   * @param footerHtml  Chromium footerTemplate (page numbers via
   *                    `<span class="pageNumber">` / `totalPages`)
   * @throws PdfUnavailableError when the engine is disabled or cannot start
   */
  render(html: string, footerHtml: string): Promise<Buffer>;
}

/**
 * The PDF engine is disabled or could not start. Invoices are still issued;
 * the PDF endpoint answers 503 INVOICE_PDF_UNAVAILABLE and emails go out
 * without the attachment.
 */
export class PdfUnavailableError extends Error {
  readonly code = 'INVOICE_PDF_UNAVAILABLE';

  constructor(
    message = 'PDF engine unavailable',
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'PdfUnavailableError';
  }
}

/** `INVOICE_PDF_ENGINE=off`: every render is unavailable. */
export class DisabledPdfRenderer implements PdfRenderer {
  render(): Promise<Buffer> {
    return Promise.reject(
      new PdfUnavailableError('PDF engine disabled (INVOICE_PDF_ENGINE=off)'),
    );
  }
}
