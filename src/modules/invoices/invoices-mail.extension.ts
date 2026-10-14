import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InvoiceKind } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { MailService } from '../mail/mail.service';
import { HTML_VAR_PREFIX } from '../notification-templates/notification-templates.service';
import type {
  MailAttachment,
  OrderEmailEvent,
  OrderForEmail,
  OrderMailExtension,
  OrderMailExtensionContext,
} from '../mail/order-mail.helpers';
import { parseInvoiceSettings } from './invoice-settings';
import { LegalProfileService, sellerSnapshot } from './legal-profile.service';
import { getInvoicePhrases } from './pdf/invoice-phrases';
import { InvoicePdfService } from './pdf/invoice-pdf.service';
import type { InvoiceSeller } from './invoices.types';

/** The variables this extension adds to every order email (§3.5). */
export const INVOICE_MAIL_VARS = [
  'invoice_number',
  'credit_note_number',
  'invoice_url',
  'seller_block_html',
  'seller_block_text',
  'seller_legal_line',
] as const;

/** Plain seller / number strings that also get an escaped `html:` copy. */
const ESCAPED_VARS = [
  'invoice_number',
  'credit_note_number',
  'seller_block_text',
  'seller_legal_line',
] as const;

type InvoiceMailVar = (typeof INVOICE_MAIL_VARS)[number];

function emptyVars(): Record<InvoiceMailVar, string> {
  return Object.fromEntries(INVOICE_MAIL_VARS.map((k) => [k, ''])) as Record<
    InvoiceMailVar,
    string
  >;
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function countryName(code: string, locale?: string): string {
  if (!code) return '';
  try {
    return (
      new Intl.DisplayNames([locale || 'en'], { type: 'region' }).of(
        code.toUpperCase(),
      ) || code
    );
  } catch {
    return code;
  }
}

/** Default time budget for rendering attachments of one email. */
export const DEFAULT_EMAIL_PDF_BUDGET_MS = 8000;

/** INVOICE_EMAIL_PDF_BUDGET_MS, or the default when unset / invalid. */
export function emailPdfBudgetMs(): number {
  const raw = Number(process.env.INVOICE_EMAIL_PDF_BUDGET_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_EMAIL_PDF_BUDGET_MS;
}

/** `work`, or a rejection once `deadline` (epoch ms) has passed. */
function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  // The work may settle after we gave up; never leave it unhandled.
  work.catch(() => undefined);
  const left = deadline - Date.now();
  if (left <= 0) {
    return Promise.reject(new Error('PDF time budget for this email used up'));
  }
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`PDF not ready within the email budget`)),
      left,
    );
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The seller block of a stored snapshot, or null when it is malformed. */
function snapshotSeller(snapshot: unknown): InvoiceSeller | null {
  const seller = (snapshot as { seller?: unknown } | null)?.seller;
  if (!seller || typeof seller !== 'object') return null;
  const s = seller as InvoiceSeller;
  if (typeof s.legal_name !== 'string' || !s.legal_name.trim()) return null;
  return s;
}

/**
 * The seller's legal identity as email lines (legal name, address, org / VAT
 * number, F-tax, contact) plus the one-line form for a footer:
 * "Neronet Academy AB · Org.nr 556036-0793 · Momsreg.nr SE556036079301".
 */
export function renderSellerBlock(
  seller: InvoiceSeller,
  locale?: string,
): { lines: string[]; legalLine: string } {
  const p = getInvoicePhrases(locale);
  const a = seller.address ?? {
    line1: '',
    line2: null,
    postal_code: '',
    city: '',
    country_code: '',
  };
  const org = seller.org_number?.trim()
    ? `${p.orgNumber} ${seller.org_number.trim()}`
    : '';
  const vat = seller.vat_number?.trim()
    ? `${p.vatNumber} ${seller.vat_number.trim()}`
    : '';
  const contact = [seller.email, seller.phone, seller.website]
    .map((v) => v?.trim() ?? '')
    .filter(Boolean)
    .join(' · ');
  const lines = [
    seller.legal_name.trim(),
    a.line1?.trim() ?? '',
    a.line2?.trim() ?? '',
    [a.postal_code, a.city]
      .map((v) => v?.trim() ?? '')
      .filter(Boolean)
      .join(' '),
    countryName(a.country_code ?? '', locale),
    org,
    vat,
    seller.registered_office?.trim()
      ? `${p.registeredOffice}: ${seller.registered_office.trim()}`
      : '',
    seller.f_tax_approved ? p.fTaxApproved : '',
    contact,
  ].filter(Boolean);
  const legalLine = [seller.legal_name.trim(), org, vat]
    .filter(Boolean)
    .join(' · ');
  return { lines, legalLine };
}

/**
 * Invoices app in order emails (D6, §3.5): the invoice / credit note
 * numbers, a link to the account page and the seller's legal block as
 * template variables, and the not-yet-emailed documents of the order as PDF
 * attachments. A store without the app costs one cached isEnabled call and
 * gets empty strings, so `{{#if}}`-guarded templates render exactly as
 * before. A PDF that cannot be rendered is left out; the email still goes.
 */
@Injectable()
export class InvoicesMailExtension implements OrderMailExtension, OnModuleInit {
  private readonly logger = new Logger(InvoicesMailExtension.name);

  constructor(
    private readonly mail: MailService,
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    private readonly pdf: InvoicePdfService,
    private readonly legalProfiles: LegalProfileService,
  ) {}

  onModuleInit(): void {
    this.mail.registerOrderMailExtension(this);
  }

  async vars(
    order: OrderForEmail,
    _event: OrderEmailEvent,
    locale: string | undefined,
    ctx: OrderMailExtensionContext,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = emptyVars();
    if (!order.store_id) return out;
    if (!(await this.storeApps.isEnabled(order.store_id, 'invoices'))) {
      return out;
    }

    const docs = await this.prisma.invoice.findMany({
      where: { order_id: order.id },
      orderBy: { issued_at: 'asc' },
      select: { kind: true, number: true, snapshot: true },
    });
    if (docs.length === 0) return out;

    const invoice = docs.find((d) => d.kind === InvoiceKind.INVOICE);
    const credit = [...docs]
      .reverse()
      .find((d) => d.kind === InvoiceKind.CREDIT_NOTE);
    out.invoice_number = invoice?.number ?? '';
    out.credit_note_number = credit?.number ?? '';
    out.invoice_url = ctx.orderUrl ? `${ctx.orderUrl}#invoices` : '';

    const seller =
      snapshotSeller(docs[docs.length - 1].snapshot) ??
      (await this.currentSeller(order));
    if (seller) {
      const block = renderSellerBlock(seller, locale);
      out.seller_block_html = block.lines.map(escapeHtml).join('<br />');
      out.seller_block_text = block.lines.join('\n');
      out.seller_legal_line = block.legalLine;
    }

    const withHtml: Record<string, string> = { ...out };
    for (const key of ESCAPED_VARS) {
      if (out[key]) withHtml[`${HTML_VAR_PREFIX}${key}`] = escapeHtml(out[key]);
    }
    return withHtml;
  }

  async attachments(
    order: OrderForEmail,
    _event: OrderEmailEvent,
  ): Promise<{
    files: MailAttachment[];
    onSent?: () => Promise<void>;
  } | null> {
    if (!order.store_id) return null;
    if (!(await this.storeApps.isEnabled(order.store_id, 'invoices'))) {
      return null;
    }
    const settings = parseInvoiceSettings(
      await this.storeApps.getSettings(order.store_id, 'invoices'),
    );
    if (!settings.attach_pdf_to_email) return null;

    const docs = await this.prisma.invoice.findMany({
      where: { order_id: order.id, emailed_at: null },
      orderBy: { issued_at: 'asc' },
      select: { id: true, number: true },
    });
    if (docs.length === 0) return null;

    // Order emails are often sent from webhook / push handlers: rendering
    // gets one hard time budget for all documents. A PDF not ready in time
    // is left out (it stays unemailed, so the next document email of the
    // order attaches it); its render keeps going and is stored for later.
    const deadline = Date.now() + emailPdfBudgetMs();
    const files: MailAttachment[] = [];
    const attachedIds: string[] = [];
    for (const doc of docs) {
      try {
        const pdf = await withDeadline(this.pdf.getPdf(doc.id), deadline);
        files.push({
          filename: pdf.filename,
          content: pdf.buffer,
          contentType: 'application/pdf',
        });
        attachedIds.push(doc.id);
      } catch (e) {
        // PdfUnavailableError (engine off / browser missing) or a render
        // failure: send the email without this document.
        this.logger.warn(
          `Invoice ${doc.number} of order ${order.id} not attached: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    }
    if (files.length === 0) return null;

    return {
      files,
      onSent: async () => {
        await this.prisma.invoice.updateMany({
          where: { id: { in: attachedIds }, emailed_at: null },
          data: { emailed_at: new Date() },
        });
      },
    };
  }

  /** The store's current seller block (only when a snapshot lacks one). */
  private async currentSeller(
    order: OrderForEmail,
  ): Promise<InvoiceSeller | null> {
    if (!order.store_id) return null;
    const profile = await this.legalProfiles.find(order.store_id);
    if (!profile) return null;
    const seller = sellerSnapshot(profile, {
      name: order.storeCtx?.name ?? '',
      logo_url: order.storeCtx?.logoUrl ?? null,
    });
    return seller.legal_name.trim() ? seller : null;
  }
}
