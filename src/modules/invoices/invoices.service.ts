import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  InvoiceKind,
  InvoiceTrigger,
  OrderStatus,
  Prisma,
  UserRole,
  type Invoice,
} from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../../prisma/prisma.service';
import { StoreAppsService } from '../store-apps/store-apps.service';
import { currencyDecimals } from '../../common/money/currency.util';
import { errorCode, invoiceErrors } from './invoice-errors';
import { InvoiceNumberingService } from './invoice-numbering.service';
import {
  bankSnapshot,
  LegalProfileService,
  sellerSnapshot,
} from './legal-profile.service';
import { profileCompleteness } from './legal-profile.util';
import {
  buildCreditSnapshot,
  buildInvoiceSnapshot,
  hasStackedTaxRates,
  isoDateInZone,
  snapshotInvariantErrors,
  withNumber,
  type SnapshotOrder,
} from './invoice-snapshot.builder';
import { invoicesToCsv, type InvoiceCsvRow } from './invoices-csv';
import {
  InvoicePdfService,
  PdfUnavailableError,
} from './pdf/invoice-pdf.service';
import type {
  InvoiceBacklog,
  InvoiceBulkIssueResult,
  InvoiceDetail,
  InvoiceListResponse,
  InvoiceSnapshot,
  InvoiceSummary,
} from './invoices.types';

export const INVOICE_LOCALES = ['en', 'ar', 'tr', 'de', 'fr', 'sv'] as const;

/** Statuses / payment states that can never be invoiced. */
const NOT_INVOICEABLE_STATUS: OrderStatus[] = [
  OrderStatus.CANCELLED,
  OrderStatus.REFUNDED,
];
const NOT_INVOICEABLE_PAYMENT = ['failed', 'refunded'];

/** Max orders one "issue all backlog" call works through. */
const BULK_ISSUE_MAX = 500;
/** Max rows of one CSV export. */
const CSV_MAX_ROWS = 10_000;

/** Everything the snapshot builder reads from an order. */
export const orderForInvoiceInclude = {
  address: true,
  customer: {
    select: {
      first_name: true,
      last_name: true,
      user: { select: { email: true } },
    },
  },
  items: {
    include: {
      product: {
        select: {
          sku: true,
          translations: { select: { locale: true, title: true } },
        },
      },
      variant: { select: { sku: true, options: true } },
      custom_product: {
        select: {
          translations: { select: { locale: true, title: true } },
          product: { select: { sku: true } },
        },
      },
      custom_field_values: {
        orderBy: { id: 'asc' },
        select: {
          value: true,
          file_url: true,
          // M4.0: order-time snapshot (read first by itemDetails).
          field_name: true,
          field_type: true,
          field_label: true,
          display_value: true,
          sort_order: true,
          // M4.1 (C1): personalization item grouping.
          group_key: true,
          group_index: true,
          group_label: true,
          source: true,
          meta: true,
          custom_field: {
            select: {
              name: true,
              type: true,
              translations: {
                select: { locale: true, label: true, option_labels: true },
              },
            },
          },
        },
      },
    },
  },
} satisfies Prisma.OrderInclude;

/** Columns of a summary (no snapshot) + what remaining_creditable needs. */
const summarySelect = {
  id: true,
  kind: true,
  number: true,
  issue_date: true,
  due_date: true,
  order_id: true,
  order_number: true,
  currency: true,
  net_total: true,
  vat_total: true,
  gross_total: true,
  paid: true,
  buyer_name: true,
  buyer_type: true,
  trigger: true,
  reason: true,
  issued_at: true,
  tax_exempt_reason: true,
  buyer_vat_number: true,
  buyer_country: true,
  credited_invoice: { select: { id: true, number: true } },
  credit_notes: { select: { gross_total: true } },
} satisfies Prisma.InvoiceSelect;

type SummaryRow = Prisma.InvoiceGetPayload<{ select: typeof summarySelect }>;

export interface IssueOptions {
  trigger: InvoiceTrigger;
  actorId?: string | null;
}

export type CreditAmount =
  | number
  | 'full'
  /** Refund provider's cumulative refunded total (gross, major units). */
  | { refundCumulative: number };

export interface CreditOptions {
  amount: CreditAmount;
  trigger: InvoiceTrigger;
  idempotencyKey: string;
  reason?: string | null;
  reasonCode?: 'refund' | 'cancellation' | null;
  actorId?: string | null;
  /** When set, the invoice must belong to this store (creator path). */
  storeId?: string;
}

export interface IssueResult {
  invoice: Invoice;
  /** false = an existing document was returned (idempotent hit). */
  created: boolean;
}

interface Reader {
  id: string;
  role: UserRole;
}

function iso(date: Date | null): string | null {
  return date ? date.toISOString().slice(0, 10) : null;
}

/** Stable JSON (sorted keys) so the hash survives jsonb key reordering. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function snapshotSha256(snapshot: InvoiceSnapshot): string {
  return createHash('sha256').update(canonicalJson(snapshot)).digest('hex');
}

/** order.locale → store primary → en, limited to the supported six (D11). */
export function resolveInvoiceLocale(
  orderLocale: string | null | undefined,
  storePrimary: string | null | undefined,
): string {
  for (const raw of [orderLocale, storePrimary]) {
    const lang = (raw ?? '').toLowerCase().split(/[-_]/)[0];
    if ((INVOICE_LOCALES as readonly string[]).includes(lang)) return lang;
  }
  return 'en';
}

function isUniqueViolation(e: unknown): boolean {
  return (
    e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'
  );
}

/**
 * Issuing, crediting and reading invoices (M3 §3.1, §3.6). Writes always
 * require the app to be in effect; reads are allowed whenever documents
 * exist (L1, bookkeeping retention).
 */
@Injectable()
export class InvoicesService {
  private readonly logger = new Logger(InvoicesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storeApps: StoreAppsService,
    private readonly profiles: LegalProfileService,
    private readonly numbering: InvoiceNumberingService,
    private readonly pdf: InvoicePdfService,
  ) {}

  // ── Store resolution ─────────────────────────────────────────────────────

  /** The creator's store id (404 STORE_NOT_FOUND when they have none). */
  async storeIdForCreator(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { store: { select: { id: true } } },
    });
    const storeId = creator?.store?.id;
    if (!storeId) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    return storeId;
  }

  // ── Issue ────────────────────────────────────────────────────────────────

  /**
   * Issue the invoice of an order (idempotent per order). Returns the
   * existing invoice with created=false when one was already issued.
   */
  async issueForOrder(
    orderId: string,
    opts: IssueOptions,
  ): Promise<IssueResult> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: orderForInvoiceInclude,
    });
    if (!order) throw invoiceErrors.orderNotEligible('Order not found.');
    if (!order.store_id) {
      throw invoiceErrors.orderNotEligible('The order has no store.');
    }
    const storeId = order.store_id;
    if (!(await this.storeApps.isEnabled(storeId, 'invoices'))) {
      throw invoiceErrors.appNotEnabled();
    }

    // Cheap idempotency pre-check (the authoritative one is under the lock).
    const already = await this.prisma.invoice.findFirst({
      where: { order_id: orderId, kind: InvoiceKind.INVOICE },
    });
    if (already) return { invoice: already, created: false };

    if (NOT_INVOICEABLE_STATUS.includes(order.status)) {
      throw invoiceErrors.orderNotEligible(
        `A ${order.status.toLowerCase()} order cannot be invoiced.`,
      );
    }
    if (NOT_INVOICEABLE_PAYMENT.includes(order.payment_status ?? '')) {
      throw invoiceErrors.orderNotEligible(
        `An order with payment status "${order.payment_status}" cannot be invoiced.`,
      );
    }

    const profile = await this.profiles.find(storeId);
    const factor = 10 ** currencyDecimals(order.currency);
    // b2b app M2.5: a reverse-charge invoice carries no VAT but must print
    // the seller's VAT number (art. 226 VAT Directive), so it is required.
    const chargesVat =
      Math.round(Number(order.tax_amount) * factor) !== 0 ||
      order.tax_exempt_reason === 'REVERSE_CHARGE';
    const completeness = profileCompleteness(profile, { chargesVat });
    if (!profile || !completeness.complete) {
      throw invoiceErrors.profileIncomplete(completeness.missing);
    }
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        name: true,
        logo_url: true,
        language_config: { select: { primary_locale: true } },
      },
    });

    const paid =
      order.payment_status === 'paid' ||
      (order.payment_method === 'COD' &&
        (order.status === OrderStatus.DELIVERED ||
          opts.trigger === InvoiceTrigger.COD_DELIVERED));
    const locale = resolveInvoiceLocale(
      order.locale,
      store?.language_config?.primary_locale,
    );
    if (hasStackedTaxRates(order as unknown as SnapshotOrder)) {
      throw invoiceErrors.snapshotInvalid(
        'Stacked tax rates are not supported on invoices yet.',
      );
    }
    const issueDate = isoDateInZone(new Date(), profile.timezone);
    const draft = buildInvoiceSnapshot({
      order: order as unknown as SnapshotOrder,
      seller: sellerSnapshot(profile, {
        name: store?.name ?? '',
        logo_url: store?.logo_url ?? null,
      }),
      bank: bankSnapshot(profile),
      locale,
      primaryLocale: store?.language_config?.primary_locale ?? null,
      issueDate,
      timezone: profile.timezone,
      dueDays: profile.due_days,
      paid,
    });
    // Refuse (before any number is allocated) rather than issue an
    // inconsistent document.
    const problems = snapshotInvariantErrors(draft);
    if (problems.length) {
      this.logger.error(
        `Invoice snapshot of order ${order.order_number} is inconsistent: ${problems.join('; ')}`,
      );
      throw invoiceErrors.snapshotInvalid(
        'The invoice totals of this order do not add up; nothing was issued.',
        problems,
      );
    }

    let result: IssueResult;
    try {
      result = await this.prisma.$transaction(
        async (tx) => {
          const seq = await this.numbering.lock(
            tx,
            profile.id,
            InvoiceKind.INVOICE,
          );
          // Under the lock, so concurrent issuers of this profile serialize.
          const existing = await tx.invoice.findFirst({
            where: { order_id: orderId, kind: InvoiceKind.INVOICE },
          });
          if (existing) return { invoice: existing, created: false };
          const { sequence_number, number } = await this.numbering.consume(
            tx,
            seq,
          );
          const snapshot = withNumber(draft, number);
          const invoice = await tx.invoice.create({
            data: {
              store_id: storeId,
              legal_profile_id: profile.id,
              order_id: orderId,
              kind: InvoiceKind.INVOICE,
              sequence_number,
              number,
              trigger: opts.trigger,
              idempotency_key: `invoice:${orderId}`,
              issue_date: new Date(`${issueDate}T00:00:00Z`),
              due_date: snapshot.refs.due_date
                ? new Date(`${snapshot.refs.due_date}T00:00:00Z`)
                : null,
              issued_by: opts.actorId ?? null,
              currency: order.currency,
              locale,
              net_total: snapshot.totals.net,
              vat_total: snapshot.totals.vat,
              gross_total: snapshot.totals.gross,
              paid,
              buyer_type: snapshot.buyer.type,
              buyer_name: snapshot.buyer.name,
              buyer_email: snapshot.buyer.email,
              order_number: order.order_number,
              // b2b app M2.5: set on INSERT only (the immutability trigger
              // refuses any later change); absent for taxed documents.
              ...(snapshot.tax_exemption
                ? {
                    tax_exempt_reason: snapshot.tax_exemption.reason,
                    buyer_vat_number: snapshot.tax_exemption.vat_number,
                    buyer_country: snapshot.tax_exemption.buyer_country,
                  }
                : {}),
              snapshot: snapshot as unknown as Prisma.InputJsonValue,
              snapshot_version: snapshot.version,
              snapshot_sha256: snapshotSha256(snapshot),
            },
          });
          return { invoice, created: true };
        },
        { timeout: 10_000, maxWait: 10_000 },
      );
    } catch (e) {
      // Second safety net (partial unique index / idempotency key).
      if (!isUniqueViolation(e)) throw e;
      const existing = await this.prisma.invoice.findFirst({
        where: { order_id: orderId, kind: InvoiceKind.INVOICE },
      });
      if (!existing) throw e;
      return { invoice: existing, created: false };
    }

    if (result.created) {
      await this.timeline(
        orderId,
        'INVOICE_ISSUED',
        `Invoice ${result.invoice.number} issued`,
        opts.actorId,
      );
    }
    return result;
  }

  /**
   * Issue a credit note against an invoice (D4): idempotent per
   * (store, idempotencyKey), capped at what is left to credit.
   * INVOICE_CREDIT_NOTHING_LEFT when the invoice is fully credited,
   * INVOICE_CREDIT_EXCEEDS when a fixed amount is above the remainder.
   */
  async issueCreditNote(
    invoiceId: string,
    opts: CreditOptions,
  ): Promise<IssueResult> {
    const original = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
    });
    if (
      !original ||
      original.kind !== InvoiceKind.INVOICE ||
      (opts.storeId && original.store_id !== opts.storeId)
    ) {
      throw invoiceErrors.notFound();
    }
    if (!(await this.storeApps.isEnabled(original.store_id, 'invoices'))) {
      throw invoiceErrors.appNotEnabled();
    }
    const profile = await this.prisma.storeLegalProfile.findUnique({
      where: { id: original.legal_profile_id },
      select: { id: true, timezone: true },
    });
    if (!profile) throw invoiceErrors.profileIncomplete(['legal_profile']);

    const factor = 10 ** currencyDecimals(original.currency);
    const toMinor = (v: unknown) => Math.round(Number(v) * factor);
    const toMajor = (m: number) => m / factor || 0;
    const issueDate = isoDateInZone(new Date(), profile.timezone);

    let result: IssueResult;
    try {
      result = await this.prisma.$transaction(
        async (tx) => {
          const seq = await this.numbering.lock(
            tx,
            profile.id,
            InvoiceKind.CREDIT_NOTE,
          );
          const existing = await tx.invoice.findUnique({
            where: {
              store_id_idempotency_key: {
                store_id: original.store_id,
                idempotency_key: opts.idempotencyKey,
              },
            },
          });
          if (existing) return { invoice: existing, created: false };

          const credits = await tx.invoice.findMany({
            where: { credited_invoice_id: original.id },
            select: { gross_total: true, trigger: true },
          });
          const prior = credits.reduce((s, c) => s - toMinor(c.gross_total), 0);
          const remaining = toMinor(original.gross_total) - prior;
          if (remaining <= 0) throw invoiceErrors.creditNothingLeft();

          let amount: number;
          const req = opts.amount;
          if (req === 'full') {
            amount = remaining;
          } else if (typeof req === 'number') {
            amount = toMinor(req);
            if (amount <= 0) {
              throw invoiceErrors.creditExceeds(toMajor(remaining));
            }
            if (amount > remaining) {
              throw invoiceErrors.creditExceeds(toMajor(remaining));
            }
          } else {
            // Refund-driven: credit what the provider refunded beyond
            // everything already credited (any trigger, so a manual credit
            // for the same money is not counted twice), never more than
            // what is left.
            const delta = toMinor(req.refundCumulative) - prior;
            if (delta <= 0) throw invoiceErrors.creditNothingLeft();
            amount = Math.min(delta, remaining);
          }

          const draft = buildCreditSnapshot({
            original: original.snapshot as unknown as InvoiceSnapshot,
            amount:
              amount === remaining && prior === 0 ? 'full' : toMajor(amount),
            priorCredited: toMajor(prior),
            issueDate,
            reasonCode: opts.reasonCode ?? null,
            reason: opts.reason ?? null,
          });
          const { sequence_number, number } = await this.numbering.consume(
            tx,
            seq,
          );
          const snapshot = withNumber(draft, number);
          const problems = snapshotInvariantErrors(snapshot);
          if (problems.length) {
            this.logger.error(
              `Credit note snapshot for ${original.number} is inconsistent: ${problems.join('; ')}`,
            );
            // Thrown inside the transaction: the allocated number rolls back.
            throw invoiceErrors.snapshotInvalid(
              'The credit note totals do not add up; nothing was issued.',
              problems,
            );
          }
          const invoice = await tx.invoice.create({
            data: {
              store_id: original.store_id,
              legal_profile_id: original.legal_profile_id,
              order_id: original.order_id,
              kind: InvoiceKind.CREDIT_NOTE,
              sequence_number,
              number,
              credited_invoice_id: original.id,
              trigger: opts.trigger,
              idempotency_key: opts.idempotencyKey,
              issue_date: new Date(`${issueDate}T00:00:00Z`),
              due_date: null,
              issued_by: opts.actorId ?? null,
              currency: original.currency,
              locale: original.locale,
              net_total: snapshot.totals.net,
              vat_total: snapshot.totals.vat,
              gross_total: snapshot.totals.gross,
              paid: original.paid,
              buyer_type: original.buyer_type,
              buyer_name: original.buyer_name,
              buyer_email: original.buyer_email,
              order_number: original.order_number,
              // b2b app M2.5: a credit note inherits the invoice's exemption
              // columns (INSERT only, like the invoice itself).
              ...(original.tax_exempt_reason
                ? {
                    tax_exempt_reason: original.tax_exempt_reason,
                    buyer_vat_number: original.buyer_vat_number,
                    buyer_country: original.buyer_country,
                  }
                : {}),
              reason: opts.reason ?? null,
              snapshot: snapshot as unknown as Prisma.InputJsonValue,
              snapshot_version: snapshot.version,
              snapshot_sha256: snapshotSha256(snapshot),
            },
          });
          return { invoice, created: true };
        },
        { timeout: 10_000, maxWait: 10_000 },
      );
    } catch (e) {
      if (!isUniqueViolation(e)) throw e;
      const existing = await this.prisma.invoice.findUnique({
        where: {
          store_id_idempotency_key: {
            store_id: original.store_id,
            idempotency_key: opts.idempotencyKey,
          },
        },
      });
      if (!existing) throw e;
      return { invoice: existing, created: false };
    }

    if (result.created) {
      await this.timeline(
        original.order_id,
        'CREDIT_NOTE_ISSUED',
        `Credit note ${result.invoice.number} issued for invoice ${original.number}`,
        opts.actorId,
      );
    }
    return result;
  }

  // ── Creator actions ──────────────────────────────────────────────────────

  /** POST /invoices/my/orders/:orderId/issue (409 when already issued). */
  async issueManually(
    storeId: string,
    orderId: string,
    actorId: string,
  ): Promise<InvoiceSummary> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: { store_id: true },
    });
    if (!order || order.store_id !== storeId) {
      throw new NotFoundException({
        code: 'ORDER_NOT_FOUND',
        message: 'Order not found',
      });
    }
    const { invoice, created } = await this.issueForOrder(orderId, {
      trigger: InvoiceTrigger.MANUAL,
      actorId,
    });
    if (!created) throw invoiceErrors.alreadyIssued(invoice.id, invoice.number);
    return this.summaryById(invoice.id);
  }

  /** POST /invoices/my/:id/credit-note (amount omitted = full remaining). */
  async creditManually(
    storeId: string,
    invoiceId: string,
    dto: { amount?: number; reason?: string },
    actorId: string,
  ): Promise<InvoiceSummary> {
    const { invoice } = await this.issueCreditNote(invoiceId, {
      amount: dto.amount ?? 'full',
      trigger: InvoiceTrigger.MANUAL,
      idempotencyKey: `manual:${invoiceId}:${randomUUID()}`,
      reason: dto.reason?.trim() || null,
      actorId,
      storeId,
    });
    return this.summaryById(invoice.id);
  }

  /** Paid orders (and delivered COD) of the store without an invoice. */
  private backlogWhere(storeId: string): Prisma.OrderWhereInput {
    return {
      store_id: storeId,
      status: { notIn: NOT_INVOICEABLE_STATUS },
      invoices: { none: { kind: InvoiceKind.INVOICE } },
      OR: [
        { payment_status: 'paid' },
        { payment_method: 'COD', status: OrderStatus.DELIVERED },
      ],
    };
  }

  async backlog(storeId: string, limit = 50): Promise<InvoiceBacklog> {
    const where = this.backlogWhere(storeId);
    const [count, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: { created_at: 'desc' },
        take: Math.min(Math.max(1, limit), 200),
        select: {
          id: true,
          order_number: true,
          created_at: true,
          total: true,
          currency: true,
          payment_method: true,
        },
      }),
    ]);
    return {
      count,
      orders: orders.map((o) => ({
        id: o.id,
        order_number: o.order_number,
        created_at: o.created_at.toISOString(),
        total: Number(o.total),
        currency: o.currency,
        payment_method: o.payment_method,
      })),
    };
  }

  /** POST /invoices/my/backlog/issue: issue every backlog order (L13). */
  async issueBacklog(
    storeId: string,
    actorId: string,
  ): Promise<InvoiceBulkIssueResult> {
    const orders = await this.prisma.order.findMany({
      where: this.backlogWhere(storeId),
      orderBy: { created_at: 'asc' },
      take: BULK_ISSUE_MAX,
      select: { id: true, order_number: true },
    });
    const out: InvoiceBulkIssueResult = { issued: 0, skipped: 0, errors: [] };
    for (const o of orders) {
      try {
        const { created } = await this.issueForOrder(o.id, {
          trigger: InvoiceTrigger.MANUAL,
          actorId,
        });
        if (created) out.issued += 1;
        else out.skipped += 1;
      } catch (e) {
        out.errors.push({
          order_id: o.id,
          order_number: o.order_number,
          code: errorCode(e) ?? 'INTERNAL_ERROR',
          message: e instanceof Error ? e.message : String(e),
        });
        // An incomplete profile fails every order the same way.
        if (errorCode(e) === 'INVOICE_PROFILE_INCOMPLETE') break;
      }
    }
    return out;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  private listWhere(
    storeId: string | null,
    q: {
      kind?: 'INVOICE' | 'CREDIT_NOTE';
      from?: string;
      to?: string;
      q?: string;
      paid?: boolean;
      store_id?: string;
    },
  ): Prisma.InvoiceWhereInput {
    const where: Prisma.InvoiceWhereInput = {};
    const store = storeId ?? q.store_id;
    if (store) where.store_id = store;
    if (q.kind) where.kind = q.kind;
    if (q.paid !== undefined) where.paid = q.paid;
    if (q.from || q.to) {
      where.issue_date = {
        ...(q.from ? { gte: new Date(`${q.from}T00:00:00Z`) } : {}),
        ...(q.to ? { lte: new Date(`${q.to}T00:00:00Z`) } : {}),
      };
    }
    const term = q.q?.trim();
    if (term) {
      where.OR = [
        { number: { contains: term, mode: 'insensitive' } },
        { order_number: { contains: term, mode: 'insensitive' } },
        { buyer_name: { contains: term, mode: 'insensitive' } },
      ];
    }
    return where;
  }

  /** Paginated list; storeId null = every store (admin). */
  async list(
    storeId: string | null,
    q: Parameters<InvoicesService['listWhere']>[1] & {
      page?: number;
      limit?: number;
    },
  ): Promise<InvoiceListResponse> {
    const where = this.listWhere(storeId, q);
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(Math.max(1, q.limit ?? 25), 100);
    const [total, rows] = await Promise.all([
      this.prisma.invoice.count({ where }),
      this.prisma.invoice.findMany({
        where,
        orderBy: [{ issue_date: 'desc' }, { issued_at: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: summarySelect,
      }),
    ]);
    return { items: rows.map((r) => this.toSummary(r)), total, page, limit };
  }

  /** CSV of the same filter (no pagination, capped). */
  async listCsv(
    storeId: string | null,
    q: Parameters<InvoicesService['listWhere']>[1],
  ): Promise<string> {
    const rows = await this.prisma.invoice.findMany({
      where: this.listWhere(storeId, q),
      orderBy: [{ issue_date: 'asc' }, { issued_at: 'asc' }],
      take: CSV_MAX_ROWS,
      select: {
        number: true,
        kind: true,
        issue_date: true,
        due_date: true,
        order_number: true,
        buyer_type: true,
        buyer_name: true,
        currency: true,
        paid: true,
        net_total: true,
        vat_total: true,
        gross_total: true,
        snapshot: true,
        tax_exempt_reason: true,
        buyer_vat_number: true,
        buyer_country: true,
        credited_invoice: { select: { number: true } },
      },
    });
    const csvRows: InvoiceCsvRow[] = rows.map((r) => ({
      number: r.number,
      kind: r.kind,
      issue_date: iso(r.issue_date) ?? '',
      due_date: iso(r.due_date),
      credited_number: r.credited_invoice?.number ?? null,
      order_number: r.order_number,
      buyer_type: r.buyer_type,
      buyer_name: r.buyer_name,
      currency: r.currency,
      paid: r.paid,
      net_total: Number(r.net_total),
      vat_total: Number(r.vat_total),
      gross_total: Number(r.gross_total),
      snapshot: r.snapshot as unknown as InvoiceSnapshot,
      tax_exempt_reason: r.tax_exempt_reason,
      buyer_vat_number: r.buyer_vat_number,
      buyer_country: r.buyer_country,
    }));
    return invoicesToCsv(csvRows);
  }

  /** GET /invoices/my/:id. */
  async detail(storeId: string, id: string): Promise<InvoiceDetail> {
    const row = await this.prisma.invoice.findUnique({
      where: { id },
      select: { ...summarySelect, store_id: true, snapshot: true },
    });
    if (!row || row.store_id !== storeId) throw invoiceErrors.notFound();
    return {
      ...this.toSummary(row),
      snapshot: row.snapshot as unknown as InvoiceSnapshot,
    };
  }

  /** GET /invoices/documents/orders/:orderId: invoices, then credit notes. */
  async findForOrder(orderId: string, user: Reader): Promise<InvoiceSummary[]> {
    await this.assertCanReadOrder(orderId, user);
    const rows = await this.prisma.invoice.findMany({
      where: { order_id: orderId },
      orderBy: [{ kind: 'asc' }, { issued_at: 'asc' }],
      select: summarySelect,
    });
    return rows.map((r) => this.toSummary(r));
  }

  /** GET /invoices/documents/:id/pdf. */
  async pdfForUser(
    invoiceId: string,
    user: Reader,
  ): Promise<{ buffer: Buffer; filename: string }> {
    const row = await this.prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { order_id: true },
    });
    if (!row) throw invoiceErrors.notFound();
    await this.assertCanReadOrder(row.order_id, user);
    try {
      return await this.pdf.getPdf(invoiceId);
    } catch (e) {
      if (e instanceof PdfUnavailableError)
        throw invoiceErrors.pdfUnavailable();
      throw e;
    }
  }

  /**
   * Same rules as OrdersService.userCanReadOrder (duplicated: OrdersService
   * is not importable from here). Admin always; customer = the buyer;
   * provider = fulfils an item; creator = owns the store or fulfils an item.
   * Foreign → 404 INVOICE_NOT_FOUND. No app check: reads stay available
   * whenever documents exist (L1).
   */
  async assertCanReadOrder(orderId: string, user: Reader): Promise<void> {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      select: {
        store_id: true,
        customer: { select: { user_id: true } },
        items: { select: { fulfiller_id: true } },
      },
    });
    if (!order || !(await this.canRead(order, user))) {
      throw invoiceErrors.notFound();
    }
  }

  private async canRead(
    order: {
      store_id: string | null;
      customer: { user_id: string } | null;
      items: { fulfiller_id: string | null }[];
    },
    user: Reader,
  ): Promise<boolean> {
    if (!user?.id || !user.role) return false;
    switch (user.role) {
      case UserRole.ADMIN:
        return true;
      case UserRole.CUSTOMER:
        return order.customer?.user_id === user.id;
      case UserRole.PROVIDER: {
        const provider = await this.prisma.provider.findUnique({
          where: { user_id: user.id },
          select: { id: true },
        });
        return (
          !!provider && order.items.some((i) => i.fulfiller_id === provider.id)
        );
      }
      case UserRole.CREATOR: {
        const creator = await this.prisma.creator.findUnique({
          where: { user_id: user.id },
          select: { id: true, store: { select: { id: true } } },
        });
        if (!creator) return false;
        if (creator.store && order.store_id === creator.store.id) return true;
        return order.items.some((i) => i.fulfiller_id === creator.id);
      }
      default:
        return false;
    }
  }

  // ── Mapping ──────────────────────────────────────────────────────────────

  private async summaryById(id: string): Promise<InvoiceSummary> {
    const row = await this.prisma.invoice.findUniqueOrThrow({
      where: { id },
      select: summarySelect,
    });
    return this.toSummary(row);
  }

  toSummary(row: SummaryRow): InvoiceSummary {
    const factor = 10 ** currencyDecimals(row.currency);
    const toMinor = (v: unknown) => Math.round(Number(v) * factor);
    const remaining =
      row.kind === InvoiceKind.INVOICE
        ? (toMinor(row.gross_total) +
            row.credit_notes.reduce((s, c) => s + toMinor(c.gross_total), 0)) /
            factor || 0
        : null;
    return {
      id: row.id,
      kind: row.kind,
      number: row.number,
      issue_date: iso(row.issue_date) ?? '',
      due_date: iso(row.due_date),
      order_id: row.order_id,
      order_number: row.order_number,
      currency: row.currency,
      net_total: Number(row.net_total),
      vat_total: Number(row.vat_total),
      gross_total: Number(row.gross_total),
      paid: row.paid,
      buyer_name: row.buyer_name,
      buyer_type: row.buyer_type,
      credited_invoice: row.credited_invoice
        ? { id: row.credited_invoice.id, number: row.credited_invoice.number }
        : null,
      trigger: row.trigger,
      reason: row.reason,
      pdf_available: process.env.INVOICE_PDF_ENGINE !== 'off',
      remaining_creditable: remaining,
      tax_exempt_reason: row.tax_exempt_reason ?? null,
      buyer_vat_number: row.buyer_vat_number ?? null,
      buyer_country: row.buyer_country ?? null,
    };
  }

  private async timeline(
    orderId: string,
    status: string,
    note: string,
    actorId?: string | null,
  ): Promise<void> {
    try {
      await this.prisma.orderTimeline.create({
        data: { order_id: orderId, status, note, actor: actorId ?? 'system' },
      });
    } catch (e) {
      this.logger.warn(
        `Timeline row ${status} for order ${orderId} failed: ${String(e)}`,
      );
    }
  }
}
