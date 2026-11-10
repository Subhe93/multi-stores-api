import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Readable } from 'stream';
import { PrismaService } from '../../../prisma/prisma.service';
import { escapeLikePattern } from '../../../common/slug/wp-slug';
import { csvText } from '../../invoices/invoices-csv';
import { BundleReadError } from '../adapters/bundle-reader';
import {
  ARCHIVE_MAX_ENTRIES,
  extractArchive,
  isArchiveName,
} from '../adapters/archive-bundle';
import { buildExternalRef } from '../model/external-ref';
import { importError } from '../importer.errors';
import {
  OrdersArchiveParseError,
  parseOrdersArchive,
  type ArchivedOrderRecord,
  type OrdersArchiveFiles,
  type OrdersArchiveIssue,
  type ParsedOrdersArchive,
} from './wc-orders-parser';
import { isAllowedOrdersArchiveFile } from './wc-orders-schema';

/**
 * WooCommerce order archive (plans/wp-order-archive, M70): import of the
 * exported order tables into `ArchivedOrder` / `ArchivedOrderLine`, and the
 * read side for the dashboard tab. Reference data only — never touches
 * Order, customers, stock, statistics or emails.
 */

/**
 * Limits (audit 2026-11-10). The archive is read and parsed synchronously in
 * the request handler — the real Namez export is 356 KB compressed / ~1.7 MB
 * expanded — so the caps are deliberately tight: 50 MB compressed, 50 MB
 * expanded (same as the bundle upload), compression ratio ≤ 20, at most
 * 64 entries (a macOS zip adds `__MACOSX/` junk, ignored by the allowlist).
 * One import per store at a time (`IMPORT_ARCHIVE_IN_PROGRESS`).
 */
export const ORDERS_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const ORDERS_ARCHIVE_MAX_EXPANDED_BYTES = 50 * 1024 * 1024;
const ORDERS_ARCHIVE_MAX_RATIO = 20;
const ORDERS_ARCHIVE_MAX_ENTRIES = ARCHIVE_MAX_ENTRIES;
/** Orders written per transaction (each one: upsert + delete lines + create lines). */
const APPLY_BATCH = 25;
const APPLY_TX_TIMEOUT_MS = 60_000;
const APPLY_TX_MAX_WAIT_MS = 10_000;
/** `external_ref IN (...)` chunk. */
const REF_CHUNK = 500;
const CSV_PAGE = 500;
const SUMMARY_MAX_ISSUES = 50;

export interface OrdersArchiveSummary {
  dry_run: boolean;
  shape: ParsedOrdersArchive['shape'];
  site_host: string | null;
  /** Hosts the product refs were resolved against (manifest + import sources). */
  resolved_hosts: string[];
  orders: { total: number; create: number; update: number; skipped: number };
  lines: { total: number; with_product: number; without_product: number };
  refunds: number;
  statuses: Record<string, number>;
  currencies: Record<string, number>;
  payment_methods: Record<string, number>;
  /** Orders without any payment method title. */
  unknown_payment_methods: number;
  date_range: { min: string | null; max: string | null };
  skipped: { external_id: string; reason: string }[];
  issues: OrdersArchiveIssue[];
  issues_total: number;
}

export interface ArchivedOrdersListQuery {
  page?: number;
  limit?: number;
  q?: string;
  status?: string;
  from?: string;
  to?: string;
}

export interface UploadedArchive {
  originalname: string;
  buffer: Buffer;
}

interface ProductRefIndex {
  hosts: string[];
  /** external ref → product id (products and variations). */
  byRef: Map<string, string>;
}

const LIST_SELECT = {
  id: true,
  external_id: true,
  number: true,
  status: true,
  created_at_source: true,
  currency: true,
  total: true,
  customer_name: true,
  customer_email: true,
  payment_method_title: true,
  imported_at: true,
} satisfies Prisma.ArchivedOrderSelect;

function dayStart(s: string): Date | null {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s)
    ? new Date(`${s}T00:00:00.000Z`)
    : new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function dayEnd(s: string): Date | null {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) return null;
    return new Date(d.getTime() + 24 * 60 * 60 * 1000 - 1);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function count(map: Record<string, number>, key: string): void {
  Object.defineProperty(map, key, {
    value: (Object.prototype.hasOwnProperty.call(map, key) ? map[key] : 0) + 1,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Title of the store's primary locale, else the first translation. */
function productName(
  translations: { locale: string; title: string; slug: string }[] | undefined,
  locale: string | null,
): { name: string; slug: string } | null {
  if (!translations?.length) return null;
  const t = translations.find((x) => x.locale === locale) ?? translations[0];
  return { name: t.title, slug: t.slug };
}

@Injectable()
export class OrdersArchiveService {
  /** Stores with an import in flight in this process (dry run or apply). */
  private readonly inFlight = new Set<string>();

  constructor(private readonly prisma: PrismaService) {}

  /** Runs `fn` as the only archive import of the store in this process; 409 otherwise. */
  private async withStoreLock<T>(
    storeId: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this.inFlight.has(storeId))
      throw new ConflictException({
        code: 'IMPORT_ARCHIVE_IN_PROGRESS',
        message: 'An orders archive import is already running for this store',
      });
    this.inFlight.add(storeId);
    try {
      return await fn();
    } finally {
      this.inFlight.delete(storeId);
    }
  }

  // ── import ──────────────────────────────────────────────────────────────

  /** Extracts the uploaded archive (tar.gz / tgz / zip) into file name → text. */
  static extractFiles(file: UploadedArchive): OrdersArchiveFiles {
    const name = (file.originalname ?? '')
      .split(/[\\/]/)
      .pop()!
      .trim()
      .toLowerCase();
    if (!isArchiveName(name))
      throw importError(
        'IMPORT_BUNDLE_INVALID_ARCHIVE',
        'Upload the orders archive as .tar.gz, .tgz or .zip',
        { file: name },
      );
    if (file.buffer.length > ORDERS_ARCHIVE_MAX_BYTES)
      throw importError(
        'IMPORT_BUNDLE_TOO_LARGE',
        `The archive is larger than ${Math.round(ORDERS_ARCHIVE_MAX_BYTES / (1024 * 1024))} MB`,
      );
    try {
      const extracted = extractArchive(file.buffer, name, {
        keep: isAllowedOrdersArchiveFile,
        maxEntries: ORDERS_ARCHIVE_MAX_ENTRIES,
        maxTotalBytes: ORDERS_ARCHIVE_MAX_EXPANDED_BYTES,
        maxRatio: ORDERS_ARCHIVE_MAX_RATIO,
      });
      const files: OrdersArchiveFiles = {};
      for (const e of extracted.entries) {
        const s = e.buffer.toString('utf8');
        files[e.name] = s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
      }
      return files;
    } catch (e) {
      if (e instanceof BundleReadError)
        throw importError(e.code, e.message, { file: name });
      throw e;
    }
  }

  /** Parses already-extracted files; parse errors become 400s. */
  static parse(files: OrdersArchiveFiles): ParsedOrdersArchive {
    try {
      return parseOrdersArchive(files);
    } catch (e) {
      if (e instanceof OrdersArchiveParseError)
        throw importError(e.code, e.message, e.file ? { file: e.file } : {});
      throw e;
    }
  }

  /**
   * Dry run (summary only) or apply (upsert by store + source + external id,
   * lines replaced) of an uploaded archive.
   */
  async importArchive(
    storeId: string,
    file: UploadedArchive,
    opts: { dryRun: boolean },
  ): Promise<OrdersArchiveSummary> {
    return this.withStoreLock(storeId, () =>
      this.importParsedUnlocked(
        storeId,
        OrdersArchiveService.parse(OrdersArchiveService.extractFiles(file)),
        opts,
      ),
    );
  }

  async importParsed(
    storeId: string,
    parsed: ParsedOrdersArchive,
    opts: { dryRun: boolean },
  ): Promise<OrdersArchiveSummary> {
    return this.withStoreLock(storeId, () =>
      this.importParsedUnlocked(storeId, parsed, opts),
    );
  }

  private async importParsedUnlocked(
    storeId: string,
    parsed: ParsedOrdersArchive,
    opts: { dryRun: boolean },
  ): Promise<OrdersArchiveSummary> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, creator_id: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    const refs = await this.productRefIndex(storeId, store.creator_id, parsed);
    const existing = new Set(
      (
        await this.prisma.archivedOrder.findMany({
          where: { store_id: storeId, source: 'woocommerce' },
          select: { external_id: true },
        })
      ).map((o) => o.external_id),
    );
    const summary = this.summarize(parsed, refs, existing, opts.dryRun);
    if (!opts.dryRun) await this.apply(storeId, parsed.orders, refs);
    return summary;
  }

  /**
   * External refs of the store's imported products / variations, for every
   * host the archive may come from: the manifest host plus the store's
   * import sources (host + aliases).
   */
  private async productRefIndex(
    storeId: string,
    creatorId: string,
    parsed: ParsedOrdersArchive,
  ): Promise<ProductRefIndex> {
    const hosts = new Set<string>();
    if (parsed.site_host) hosts.add(parsed.site_host);
    const sources = await this.prisma.importSource.findMany({
      where: { store_id: storeId },
      select: { site_host: true, host_aliases: true },
    });
    for (const s of sources) {
      hosts.add(s.site_host);
      for (const a of s.host_aliases ?? []) hosts.add(a);
    }
    const index: ProductRefIndex = { hosts: [...hosts], byRef: new Map() };
    if (!hosts.size) return index;

    const productRefs = new Set<string>();
    const variationRefs = new Set<string>();
    for (const o of parsed.orders)
      for (const l of o.lines) {
        for (const h of hosts) {
          try {
            if (l.product_external_id)
              productRefs.add(
                buildExternalRef(h, 'product', l.product_external_id),
              );
            if (l.variation_external_id)
              variationRefs.add(
                buildExternalRef(h, 'variation', l.variation_external_id),
              );
          } catch {
            // Unusable id (not matching the ref grammar): no match.
          }
        }
      }

    for (const chunk of chunks([...productRefs], REF_CHUNK)) {
      const rows = await this.prisma.product.findMany({
        where: { creator_id: creatorId, external_ref: { in: chunk } },
        select: { id: true, external_ref: true },
      });
      for (const r of rows)
        if (r.external_ref) index.byRef.set(r.external_ref, r.id);
    }
    for (const chunk of chunks([...variationRefs], REF_CHUNK)) {
      const variants = await this.prisma.productVariant.findMany({
        where: { external_ref: { in: chunk } },
        select: { product_id: true, external_ref: true },
      });
      if (!variants.length) continue;
      // Only variants of this store's products count.
      const owned = new Set(
        (
          await this.prisma.product.findMany({
            where: {
              creator_id: creatorId,
              id: { in: [...new Set(variants.map((v) => v.product_id))] },
            },
            select: { id: true },
          })
        ).map((p) => p.id),
      );
      for (const v of variants)
        if (v.external_ref && owned.has(v.product_id))
          index.byRef.set(v.external_ref, v.product_id);
    }
    return index;
  }

  /** Product id a line resolves to: the variation's product first, then the product. */
  private resolveProduct(
    refs: ProductRefIndex,
    line: {
      product_external_id: string | null;
      variation_external_id: string | null;
    },
  ): string | null {
    for (const h of refs.hosts) {
      try {
        if (line.variation_external_id) {
          const hit = refs.byRef.get(
            buildExternalRef(h, 'variation', line.variation_external_id),
          );
          if (hit) return hit;
        }
        if (line.product_external_id) {
          const hit = refs.byRef.get(
            buildExternalRef(h, 'product', line.product_external_id),
          );
          if (hit) return hit;
        }
      } catch {
        // Unusable id: no match.
      }
    }
    return null;
  }

  private summarize(
    parsed: ParsedOrdersArchive,
    refs: ProductRefIndex,
    existing: Set<string>,
    dryRun: boolean,
  ): OrdersArchiveSummary {
    const s: OrdersArchiveSummary = {
      dry_run: dryRun,
      shape: parsed.shape,
      site_host: parsed.site_host,
      resolved_hosts: refs.hosts,
      orders: {
        total: parsed.orders.length,
        create: 0,
        update: 0,
        skipped: parsed.skipped.length,
      },
      lines: { total: 0, with_product: 0, without_product: 0 },
      refunds: 0,
      statuses: {},
      currencies: {},
      payment_methods: {},
      unknown_payment_methods: 0,
      date_range: { min: null, max: null },
      skipped: parsed.skipped.slice(0, SUMMARY_MAX_ISSUES),
      issues: parsed.issues.slice(0, SUMMARY_MAX_ISSUES),
      issues_total: parsed.issues.length,
    };
    let min: Date | null = null;
    let max: Date | null = null;
    for (const o of parsed.orders) {
      if (existing.has(o.external_id)) s.orders.update++;
      else s.orders.create++;
      count(s.statuses, o.status);
      count(s.currencies, o.currency || '?');
      if (o.payment_method_title)
        count(s.payment_methods, o.payment_method_title);
      else s.unknown_payment_methods++;
      s.refunds += o.refunds.length;
      if (!min || o.created_at < min) min = o.created_at;
      if (!max || o.created_at > max) max = o.created_at;
      for (const l of o.lines) {
        s.lines.total++;
        if (this.resolveProduct(refs, l)) s.lines.with_product++;
        else s.lines.without_product++;
      }
    }
    s.date_range = {
      min: min ? min.toISOString() : null,
      max: max ? max.toISOString() : null,
    };
    return s;
  }

  private async apply(
    storeId: string,
    orders: ArchivedOrderRecord[],
    refs: ProductRefIndex,
  ): Promise<void> {
    for (const batch of chunks(orders, APPLY_BATCH)) {
      await this.prisma.$transaction(
        async (tx) => {
          // Cross-instance guard (the in-process lock covers one API only):
          // a second apply for the same store waits for this batch instead of
          // racing the upserts into P2002.
          await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${storeId}))`;
          for (const o of batch) {
            const data = {
              number: o.number,
              status: o.status,
              created_at_source: o.created_at,
              currency: o.currency || 'XXX',
              subtotal: o.subtotal,
              shipping_total: o.shipping_total,
              discount_total: o.discount_total,
              tax_total: o.tax_total,
              total: o.total,
              payment_method_title: o.payment_method_title,
              shipping_method_title: o.shipping_method_title,
              customer_name: o.customer_name,
              customer_email: o.customer_email,
              customer_phone: o.customer_phone,
              billing_address: (o.billing_address ??
                Prisma.DbNull) as Prisma.InputJsonValue,
              shipping_address: (o.shipping_address ??
                Prisma.DbNull) as Prisma.InputJsonValue,
              customer_note: o.customer_note,
              refunds: o.refunds as unknown as Prisma.InputJsonValue,
              raw: o.raw as Prisma.InputJsonValue,
              imported_at: new Date(),
            };
            const row = await tx.archivedOrder.upsert({
              where: {
                store_id_source_external_id: {
                  store_id: storeId,
                  source: 'woocommerce',
                  external_id: o.external_id,
                },
              },
              create: {
                store_id: storeId,
                source: 'woocommerce',
                external_id: o.external_id,
                ...data,
              },
              update: data,
              select: { id: true },
            });
            await tx.archivedOrderLine.deleteMany({
              where: { archived_order_id: row.id },
            });
            if (o.lines.length)
              await tx.archivedOrderLine.createMany({
                data: o.lines.map((l) => ({
                  archived_order_id: row.id,
                  position: l.position,
                  name: l.name,
                  sku: l.sku,
                  quantity: l.quantity,
                  unit_price: l.unit_price,
                  line_total: l.line_total,
                  line_tax: l.line_tax,
                  product_external_id: l.product_external_id,
                  variation_external_id: l.variation_external_id,
                  product_id: this.resolveProduct(refs, l),
                  meta: (l.meta ?? Prisma.DbNull) as Prisma.InputJsonValue,
                })),
              });
          }
        },
        { timeout: APPLY_TX_TIMEOUT_MS, maxWait: APPLY_TX_MAX_WAIT_MS },
      );
    }
  }

  // ── reads ───────────────────────────────────────────────────────────────

  async summary(storeId: string) {
    const agg = await this.prisma.archivedOrder.aggregate({
      where: { store_id: storeId },
      _count: { _all: true },
      _min: { created_at_source: true },
      _max: { created_at_source: true },
    });
    return {
      count: agg._count._all,
      min_date: agg._min.created_at_source ?? null,
      max_date: agg._max.created_at_source ?? null,
    };
  }

  private listWhere(
    storeId: string,
    q: ArchivedOrdersListQuery,
  ): Prisma.ArchivedOrderWhereInput {
    const where: Prisma.ArchivedOrderWhereInput = { store_id: storeId };
    const term = (q.q ?? '').trim();
    if (term) {
      const needle = escapeLikePattern(term);
      where.OR = [
        { number: { contains: needle, mode: 'insensitive' } },
        { customer_name: { contains: needle, mode: 'insensitive' } },
        { customer_email: { contains: needle, mode: 'insensitive' } },
      ];
    }
    const status = (q.status ?? '').trim().toLowerCase();
    if (status) where.status = status;
    const from = q.from ? dayStart(q.from) : null;
    const to = q.to ? dayEnd(q.to) : null;
    if (from || to)
      where.created_at_source = {
        ...(from ? { gte: from } : {}),
        ...(to ? { lte: to } : {}),
      };
    return where;
  }

  async list(storeId: string, q: ArchivedOrdersListQuery) {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(200, Math.max(1, q.limit ?? 20));
    const where = this.listWhere(storeId, q);
    const [total, rows] = await Promise.all([
      this.prisma.archivedOrder.count({ where }),
      this.prisma.archivedOrder.findMany({
        where,
        orderBy: [{ created_at_source: 'desc' }, { external_id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: LIST_SELECT,
      }),
    ]);
    const counts = await this.lineCounts(rows.map((r) => r.id));
    return {
      data: rows.map((o) => ({ ...o, lines_count: counts.get(o.id) ?? 0 })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  }

  /** Line count per archived order id (one grouped query per page). */
  private async lineCounts(ids: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    if (!ids.length) return out;
    const groups = await this.prisma.archivedOrderLine.groupBy({
      by: ['archived_order_id'],
      where: { archived_order_id: { in: ids } },
      _count: { _all: true },
    });
    for (const g of groups) out.set(g.archived_order_id, g._count._all);
    return out;
  }

  async detail(storeId: string, id: string) {
    const order = await this.prisma.archivedOrder.findFirst({
      where: { id, store_id: storeId },
    });
    if (!order)
      throw new NotFoundException({
        code: 'ARCHIVED_ORDER_NOT_FOUND',
        message: 'Archived order not found',
      });
    const lines = await this.prisma.archivedOrderLine.findMany({
      where: { archived_order_id: order.id },
      orderBy: { position: 'asc' },
    });
    const productIds = [
      ...new Set(
        lines.map((l) => l.product_id).filter((x): x is string => !!x),
      ),
    ];
    const products = productIds.length
      ? await this.prisma.product.findMany({
          where: { id: { in: productIds } },
          select: {
            id: true,
            translations: { select: { locale: true, title: true, slug: true } },
          },
        })
      : [];
    const locale = productIds.length
      ? ((
          await this.prisma.storeLanguageConfig.findUnique({
            where: { store_id: storeId },
            select: { primary_locale: true },
          })
        )?.primary_locale ?? null)
      : null;
    const byId = new Map(
      products.map((p) => [p.id, productName(p.translations, locale)]),
    );
    return {
      ...order,
      lines: lines.map((l) => {
        const p = l.product_id ? byId.get(l.product_id) : null;
        return {
          ...l,
          product: l.product_id && p ? { id: l.product_id, ...p } : null,
        };
      }),
    };
  }

  /** CSV of the filtered list (streamed page by page; BOM first). */
  exportCsvStream(storeId: string, q: ArchivedOrdersListQuery): Readable {
    const where = this.listWhere(storeId, q);
    const prisma = this.prisma;
    const lineCounts = (ids: string[]) => this.lineCounts(ids);
    async function* rows(): AsyncGenerator<string> {
      yield '﻿' +
        [
          'number',
          'external_id',
          'date',
          'status',
          'customer_name',
          'customer_email',
          'customer_phone',
          'currency',
          'subtotal',
          'shipping_total',
          'discount_total',
          'tax_total',
          'total',
          'refunded_total',
          'payment_method',
          'shipping_method',
          'lines',
          'billing_country',
          'shipping_country',
        ].join(',') +
        '\n';
      for (let skip = 0; ; skip += CSV_PAGE) {
        const page = await prisma.archivedOrder.findMany({
          where,
          orderBy: [{ created_at_source: 'desc' }, { external_id: 'desc' }],
          skip,
          take: CSV_PAGE,
          select: {
            id: true,
            number: true,
            external_id: true,
            created_at_source: true,
            status: true,
            customer_name: true,
            customer_email: true,
            customer_phone: true,
            currency: true,
            subtotal: true,
            shipping_total: true,
            discount_total: true,
            tax_total: true,
            total: true,
            refunds: true,
            payment_method_title: true,
            shipping_method_title: true,
            billing_address: true,
            shipping_address: true,
          },
        });
        if (!page.length) return;
        const counts = await lineCounts(page.map((o) => o.id));
        yield page
          .map((o) => {
            const refunds = Array.isArray(o.refunds)
              ? (o.refunds as { amount?: unknown }[]).reduce(
                  (n, r) => n + (Number(r?.amount ?? 0) || 0),
                  0,
                )
              : 0;
            const billing = (o.billing_address ?? {}) as { country?: string };
            const shipping = (o.shipping_address ?? {}) as { country?: string };
            return (
              [
                csvText(o.number),
                csvText(o.external_id),
                o.created_at_source.toISOString(),
                csvText(o.status),
                csvText(o.customer_name),
                csvText(o.customer_email),
                csvText(o.customer_phone),
                csvText(o.currency),
                String(o.subtotal),
                String(o.shipping_total),
                String(o.discount_total),
                String(o.tax_total),
                String(o.total),
                refunds.toFixed(2),
                csvText(o.payment_method_title),
                csvText(o.shipping_method_title),
                String(counts.get(o.id) ?? 0),
                csvText(billing.country ?? ''),
                csvText(shipping.country ?? ''),
              ].join(',') + '\n'
            );
          })
          .join('');
        if (page.length < CSV_PAGE) return;
      }
    }
    return Readable.from(rows(), { encoding: 'utf8' });
  }

  /** The whole CSV as a string (tests). */
  async exportCsv(
    storeId: string,
    q: ArchivedOrdersListQuery,
  ): Promise<string> {
    let out = '';
    for await (const chunk of this.exportCsvStream(storeId, q))
      out += String(chunk);
    return out.startsWith('﻿') ? out.slice(1) : out;
  }
}

function* chunks<T>(list: T[], size: number): Generator<T[]> {
  for (let i = 0; i < list.length; i += size) yield list.slice(i, i + size);
}
