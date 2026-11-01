import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma, UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizeEmail } from '../../common/email/email.util';
import { generateAccountPassword } from '../../common/security/account-password';
import { resolveStoreCurrency } from '../../common/money/currency.util';
import {
  countedOrderSql,
  round2,
  storeAmountSql,
} from '../overview/overview-range';
import {
  MagicLinkService,
  MAGIC_LINK_TTL_HOURS,
} from '../auth/magic-link.service';
import { AccountLinksService } from '../auth/account-links.service';
import { AccountCredentialsService } from '../auth/account-credentials.service';
import { AuthService } from '../auth/auth.service';
import { MailService } from '../mail/mail.service';
import { normalizeProfileOrgNumber } from '../customers/customers.service';
import { normalizeVatNumber } from '../b2b/vat-number.util';
import { csvAmount, csvText } from '../invoices/invoices-csv';
import type {
  BulkCustomersDto,
  CreateStoreCustomerDto,
  CustomerSettableStatus,
  CustomerSortKey,
  ListCustomersQueryDto,
  UpdateStoreCustomerDto,
} from './dto/store-customers.dto';

/** Password hash cost of accounts created here (same as auth). */
const BCRYPT_COST = 12;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
/** Upper bound of one CSV export. */
export const CUSTOMERS_EXPORT_MAX_ROWS = 50_000;
const RECENT_ORDERS_LIMIT = 10;

/**
 * Per-store caps on the emails a store owner can trigger, over a rolling 24 h
 * window. Counted from EmailLog rows (store_id + event, any delivery status),
 * so no extra storage is needed. `account_created` also counts the guest
 * checkout credentials mails of the store; only owner-triggered sends are
 * refused when the cap is reached.
 */
export const STORE_DAILY_EMAIL_LIMITS = {
  customer_login_link: 300,
  account_created: 200,
} as const;
export type StoreDailyEmailEvent = keyof typeof STORE_DAILY_EMAIL_LIMITS;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The store a request is scoped to. */
export interface CustomerStoreScope {
  id: string;
  slug: string;
  name: string;
  /** Store currency (resolveStoreCurrency), the unit of total_spent. */
  currency: string;
}

/** One row of the customers list (and of the CSV). */
export interface CustomerListRow {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  customer_type: string | null;
  company_name: string | null;
  orders_count: number;
  total_spent: number;
  currency: string;
  last_order_at: string | null;
  created_at: string;
  /** Admin list only. */
  store?: { id: string; name: string; slug: string };
}

export interface CustomerListResult {
  data: CustomerListRow[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export interface BulkResult {
  action: BulkCustomersDto['action'];
  requested: number;
  succeeded: string[];
  skipped: {
    id: string;
    reason: 'not_found' | 'not_active' | 'banned' | 'daily_limit';
  }[];
}

const notFound = () =>
  new NotFoundException({
    code: 'CUSTOMER_NOT_FOUND',
    message: 'Customer not found',
  });

const storeNotFound = () =>
  new NotFoundException({
    code: 'STORE_NOT_FOUND',
    message: 'Store not found',
  });

const notActive = () =>
  new BadRequestException({
    code: 'CUSTOMER_NOT_ACTIVE',
    message: 'The customer account is blocked.',
  });

/** A BANNED account was banned by the platform admin; the owner cannot lift it. */
const bannedByAdmin = () =>
  new ForbiddenException({
    code: 'CUSTOMER_BANNED_BY_ADMIN',
    message: 'This customer was banned by the platform and cannot be changed.',
  });

const dailyLimit = (event: StoreDailyEmailEvent) =>
  new HttpException(
    {
      code: 'STORE_DAILY_EMAIL_LIMIT',
      message: `The store reached its daily limit of ${STORE_DAILY_EMAIL_LIMITS[event]} ${event} emails. Try again later.`,
      event,
      limit: STORE_DAILY_EMAIL_LIMITS[event],
    },
    HttpStatus.TOO_MANY_REQUESTS,
  );

/** Start (from) or end (to) of a YYYY-MM-DD day, else the ISO instant. */
export function parseDateBound(
  raw: string | undefined,
  edge: 'from' | 'to',
): Date | null {
  if (!raw) return null;
  const dayOnly = /^\d{4}-\d{2}-\d{2}$/.test(raw);
  const d = new Date(
    dayOnly
      ? `${raw}T${edge === 'from' ? '00:00:00.000' : '23:59:59.999'}Z`
      : raw,
  );
  if (Number.isNaN(d.getTime())) {
    throw new BadRequestException({
      code: 'CUSTOMER_INVALID_DATE',
      message: `${edge} is not a valid date`,
    });
  }
  return d;
}

/** ILIKE pattern with the wildcards of the input escaped. */
function likePattern(search: string): string {
  return `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** SQL timestamp (UTC wall clock) of a JS date, as Prisma stores DateTime. */
const ts = (d: Date) =>
  Prisma.sql`(${d.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

interface RawRow {
  id: string;
  user_id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
  status: UserStatus;
  customer_type: string | null;
  company_name: string | null;
  store_id: string;
  orders_count: number;
  total_spent: number | null;
  last_order_at: Date | null;
  created_at: Date;
}

/**
 * Customers of a store (User.store_id) for the creator's dashboard and the
 * admin. Order aggregates follow the overview rules exactly: counted orders
 * are `countedOrderSql` and money is converted to the store currency with
 * `storeAmountSql` (both from overview-range.ts).
 */
@Injectable()
export class StoreCustomersService {
  private readonly logger = new Logger(StoreCustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly magicLinks: MagicLinkService,
    private readonly links: AccountLinksService,
    private readonly credentials: AccountCredentialsService,
    private readonly auth: AuthService,
    private readonly mail: MailService,
  ) {}

  // ── Store resolution ─────────────────────────────────────────────────────

  /** The creator's own store (404 STORE_NOT_FOUND without one). */
  async storeForCreator(userId: string): Promise<CustomerStoreScope> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: {
        store: {
          select: {
            id: true,
            slug: true,
            name: true,
            store_type: true,
            currency: true,
          },
        },
      },
    });
    if (!creator?.store) throw storeNotFound();
    return this.scopeOf(creator.store);
  }

  /** Any store by id (admin). */
  async storeById(storeId: string): Promise<CustomerStoreScope> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        slug: true,
        name: true,
        store_type: true,
        currency: true,
      },
    });
    if (!store) throw storeNotFound();
    return this.scopeOf(store);
  }

  private async platformCurrency(): Promise<string | null> {
    const platform = await this.prisma.platformConfig.findFirst({
      select: { default_currency: true },
    });
    return platform?.default_currency ?? null;
  }

  private async scopeOf(store: {
    id: string;
    slug: string;
    name: string;
    store_type: string;
    currency: string | null;
  }): Promise<CustomerStoreScope> {
    return {
      id: store.id,
      slug: store.slug,
      name: store.name,
      currency: resolveStoreCurrency(store, await this.platformCurrency()),
    };
  }

  // ── List / export ────────────────────────────────────────────────────────

  /**
   * WHERE of the list: customers of `storeId` (every store when null) plus
   * the query filters. `a` is the aggregate lateral of `fromSql`.
   */
  private whereSql(
    storeId: string | null,
    q: ListCustomersQueryDto,
  ): Prisma.Sql {
    const parts: Prisma.Sql[] = [Prisma.sql`u.role = 'CUSTOMER'`];
    if (storeId) parts.push(Prisma.sql`u.store_id = ${storeId}`);
    else parts.push(Prisma.sql`u.store_id IS NOT NULL`);
    const search = q.search?.trim();
    if (search) {
      const p = likePattern(search);
      parts.push(Prisma.sql`(
        u.email ILIKE ${p}
        OR c.first_name ILIKE ${p}
        OR c.last_name ILIKE ${p}
        OR (c.first_name || ' ' || c.last_name) ILIKE ${p}
        OR c.phone ILIKE ${p}
        OR c.company_name ILIKE ${p}
      )`);
    }
    if (q.status) parts.push(Prisma.sql`u.status::text = ${q.status}`);
    if (q.customer_type === 'COMPANY') {
      parts.push(Prisma.sql`c.customer_type::text = 'COMPANY'`);
    } else if (q.customer_type === 'PERSON') {
      parts.push(
        Prisma.sql`(c.customer_type IS NULL OR c.customer_type::text = 'PERSON')`,
      );
    }
    if (q.has_orders === 'true') parts.push(Prisma.sql`a.orders_count > 0`);
    if (q.has_orders === 'false') parts.push(Prisma.sql`a.orders_count = 0`);
    const from = parseDateBound(q.from, 'from');
    const to = parseDateBound(q.to, 'to');
    if (from) parts.push(Prisma.sql`u.created_at >= ${ts(from)}`);
    if (to) parts.push(Prisma.sql`u.created_at <= ${ts(to)}`);
    return Prisma.join(parts, ' AND ');
  }

  /**
   * FROM with the per-customer aggregates over the counted orders of the
   * customer's own store. `currency` set: total_spent in that currency
   * (single-store scope); null: total_spent is filled per store afterwards.
   */
  private fromSql(currency: string | null): Prisma.Sql {
    const spent = currency
      ? Prisma.sql`SUM(${storeAmountSql(Prisma.sql`o.total`, currency)})::float8`
      : Prisma.sql`NULL::float8`;
    return Prisma.sql`"User" u
      JOIN "Customer" c ON c.user_id = u.id
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS orders_count,
               ${spent} AS total_spent,
               MAX(o.created_at) AS last_order_at
          FROM "Order" o
         WHERE o.customer_id = c.id
           AND o.store_id = u.store_id
           AND ${countedOrderSql('o')}
      ) a ON true`;
  }

  private orderSql(
    sort: CustomerSortKey | undefined,
    dir: 'asc' | 'desc' | undefined,
    allowSpent: boolean,
  ): Prisma.Sql {
    const key: CustomerSortKey =
      sort && (allowSpent || sort !== 'total_spent') ? sort : 'created_at';
    const d = Prisma.raw((dir ?? 'desc') === 'asc' ? 'ASC' : 'DESC');
    // Every key is a fixed fragment (never user input); u.id breaks ties so
    // pages are stable.
    const col: Record<CustomerSortKey, Prisma.Sql> = {
      name: Prisma.sql`lower(c.first_name || ' ' || c.last_name)`,
      email: Prisma.sql`lower(u.email)`,
      orders_count: Prisma.sql`a.orders_count`,
      total_spent: Prisma.sql`COALESCE(a.total_spent, 0)`,
      last_order_at: Prisma.sql`a.last_order_at`,
      created_at: Prisma.sql`u.created_at`,
    };
    return Prisma.sql`ORDER BY ${col[key]} ${d} NULLS LAST, u.id ${d}`;
  }

  private async queryRows(
    storeId: string | null,
    currency: string | null,
    q: ListCustomersQueryDto,
    limit: number,
    offset: number,
  ): Promise<RawRow[]> {
    return this.prisma.$queryRaw<RawRow[]>(Prisma.sql`
      SELECT c.id, u.id AS user_id, c.first_name, c.last_name, u.email,
             c.phone, u.status, c.customer_type::text AS customer_type,
             c.company_name, u.store_id,
             COALESCE(a.orders_count, 0)::int AS orders_count,
             a.total_spent, a.last_order_at, u.created_at
        FROM ${this.fromSql(currency)}
       WHERE ${this.whereSql(storeId, q)}
       ${this.orderSql(q.sort, q.dir, currency != null)}
       LIMIT ${limit} OFFSET ${offset}`);
  }

  private async countRows(
    storeId: string | null,
    q: ListCustomersQueryDto,
  ): Promise<number> {
    const rows = await this.prisma.$queryRaw<{ n: number }[]>(Prisma.sql`
      SELECT COUNT(*)::int AS n
        FROM ${this.fromSql(null)}
       WHERE ${this.whereSql(storeId, q)}`);
    return Number(rows[0]?.n ?? 0);
  }

  private toRow(r: RawRow, currency: string): CustomerListRow {
    return {
      id: r.id,
      user_id: r.user_id,
      first_name: r.first_name,
      last_name: r.last_name,
      email: r.email,
      phone: r.phone,
      status: r.status,
      customer_type: r.customer_type,
      company_name: r.company_name,
      orders_count: Number(r.orders_count) || 0,
      total_spent: round2(Number(r.total_spent) || 0),
      currency,
      last_order_at: r.last_order_at ? r.last_order_at.toISOString() : null,
      created_at: r.created_at.toISOString(),
    };
  }

  private pageOf(q: ListCustomersQueryDto) {
    const page = Math.max(1, Math.floor(Number(q.page) || 1));
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, Math.floor(Number(q.limit) || DEFAULT_LIMIT)),
    );
    return { page, limit, offset: (page - 1) * limit };
  }

  /** `GET /stores/my/customers`: one store, sortable by every key. */
  async list(
    store: CustomerStoreScope,
    q: ListCustomersQueryDto,
  ): Promise<CustomerListResult> {
    const { page, limit, offset } = this.pageOf(q);
    const [rows, total] = await Promise.all([
      this.queryRows(store.id, store.currency, q, limit, offset),
      this.countRows(store.id, q),
    ]);
    return {
      data: rows.map((r) => this.toRow(r, store.currency)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Every row of the filtered list as CSV (no BOM; the controller adds it). */
  async exportCsv(
    store: CustomerStoreScope,
    q: ListCustomersQueryDto,
  ): Promise<string> {
    const rows = await this.queryRows(
      store.id,
      store.currency,
      q,
      CUSTOMERS_EXPORT_MAX_ROWS,
      0,
    );
    return customersCsv(rows.map((r) => this.toRow(r, store.currency)));
  }

  /**
   * `GET /admin/customers`: every store (or one). Stores have different
   * currencies, so total_spent is computed per store of the page and
   * sorting by it is not offered (falls back to created_at).
   */
  async adminList(
    q: ListCustomersQueryDto & { store_id?: string },
  ): Promise<CustomerListResult> {
    const { page, limit, offset } = this.pageOf(q);
    const storeId = q.store_id ?? null;
    const [rows, total] = await Promise.all([
      this.queryRows(storeId, null, q, limit, offset),
      this.countRows(storeId, q),
    ]);
    const storeIds = [...new Set(rows.map((r) => r.store_id))];
    const stores = storeIds.length
      ? await this.prisma.store.findMany({
          where: { id: { in: storeIds } },
          select: {
            id: true,
            slug: true,
            name: true,
            store_type: true,
            currency: true,
          },
        })
      : [];
    const platform = await this.platformCurrency();
    const byStore = new Map(
      stores.map((s) => [
        s.id,
        {
          id: s.id,
          slug: s.slug,
          name: s.name,
          currency: resolveStoreCurrency(s, platform),
        },
      ]),
    );
    const spent = new Map<string, number>();
    for (const s of byStore.values()) {
      const ids = rows.filter((r) => r.store_id === s.id).map((r) => r.id);
      for (const [id, v] of await this.spentByCustomer(s, ids)) {
        spent.set(id, v);
      }
    }
    return {
      data: rows.map((r) => {
        const s = byStore.get(r.store_id);
        const row = this.toRow(
          { ...r, total_spent: spent.get(r.id) ?? 0 },
          s?.currency ?? platform ?? 'EUR',
        );
        if (s) row.store = { id: s.id, name: s.name, slug: s.slug };
        return row;
      }),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Counted spend per customer in one store, in the store currency. */
  private async spentByCustomer(
    store: CustomerStoreScope,
    customerIds: string[],
  ): Promise<Map<string, number>> {
    if (!customerIds.length) return new Map();
    const rows = await this.prisma.$queryRaw<
      { customer_id: string; spent: number | null }[]
    >(Prisma.sql`
      SELECT o.customer_id,
             SUM(${storeAmountSql(Prisma.sql`o.total`, store.currency)})::float8 AS spent
        FROM "Order" o
       WHERE o.store_id = ${store.id}
         AND o.customer_id IN (${Prisma.join(customerIds)})
         AND ${countedOrderSql('o')}
       GROUP BY o.customer_id`);
    return new Map(rows.map((r) => [r.customer_id, Number(r.spent) || 0]));
  }

  // ── Detail ───────────────────────────────────────────────────────────────

  /** The customer row of `customerId` when it belongs to the store. */
  private async findInStore(customerId: string, storeId: string | null) {
    const customer = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            role: true,
            status: true,
            store_id: true,
            created_at: true,
          },
        },
      },
    });
    if (
      !customer ||
      customer.user.role !== UserRole.CUSTOMER ||
      !customer.user.store_id ||
      (storeId != null && customer.user.store_id !== storeId)
    ) {
      throw notFound();
    }
    return customer;
  }

  async detail(store: CustomerStoreScope, customerId: string) {
    const customer = await this.findInStore(customerId, store.id);
    const [addresses, statsRows, allOrders, recent, exemption] =
      await Promise.all([
        this.prisma.address.findMany({
          where: { customer_id: customer.id },
          orderBy: [{ is_default: 'desc' }, { created_at: 'asc' }],
        }),
        this.prisma.$queryRaw<
          {
            orders_count: number;
            total_spent: number | null;
            first_order_at: Date | null;
            last_order_at: Date | null;
          }[]
        >(Prisma.sql`
          SELECT COUNT(*)::int AS orders_count,
                 SUM(${storeAmountSql(Prisma.sql`o.total`, store.currency)})::float8 AS total_spent,
                 MIN(o.created_at) AS first_order_at,
                 MAX(o.created_at) AS last_order_at
            FROM "Order" o
           WHERE o.customer_id = ${customer.id}
             AND o.store_id = ${store.id}
             AND ${countedOrderSql('o')}`),
        this.prisma.order.count({
          where: { customer_id: customer.id, store_id: store.id },
        }),
        this.prisma.order.findMany({
          where: { customer_id: customer.id, store_id: store.id },
          orderBy: { created_at: 'desc' },
          take: RECENT_ORDERS_LIMIT,
          select: {
            id: true,
            order_number: true,
            status: true,
            payment_status: true,
            payment_method: true,
            total: true,
            currency: true,
            created_at: true,
          },
        }),
        this.prisma.storeCustomerTaxExemption.findFirst({
          where: {
            store_id: store.id,
            customer_id: customer.id,
            revoked_at: null,
          },
          select: {
            id: true,
            kind: true,
            vat_number: true,
            note: true,
            created_at: true,
          },
        }),
      ]);
    const s = statsRows[0];
    const ordersCount = Number(s?.orders_count) || 0;
    const totalSpent = round2(Number(s?.total_spent) || 0);
    return {
      id: customer.id,
      user_id: customer.user.id,
      email: customer.user.email,
      status: customer.user.status,
      first_name: customer.first_name,
      last_name: customer.last_name,
      phone: customer.phone,
      customer_type: customer.customer_type,
      company_name: customer.company_name,
      org_number: customer.org_number,
      vat_number: customer.vat_number,
      created_at: customer.user.created_at.toISOString(),
      updated_at: customer.updated_at.toISOString(),
      store: { id: store.id, name: store.name, slug: store.slug },
      addresses,
      stats: {
        orders_count: ordersCount,
        total_spent: totalSpent,
        average_order: ordersCount ? round2(totalSpent / ordersCount) : 0,
        first_order_at: s?.first_order_at?.toISOString() ?? null,
        last_order_at: s?.last_order_at?.toISOString() ?? null,
        all_orders_count: allOrders,
        currency: store.currency,
      },
      recent_orders: recent.map((o) => ({
        ...o,
        total: Number(o.total),
        created_at: o.created_at.toISOString(),
      })),
      tax_exemption: exemption
        ? { ...exemption, created_at: exemption.created_at.toISOString() }
        : null,
    };
  }

  /** Admin detail: the store comes from the customer. */
  async adminDetail(customerId: string) {
    const customer = await this.findInStore(customerId, null);
    const store = await this.storeById(customer.user.store_id!);
    return this.detail(store, customerId);
  }

  // ── Create / edit ────────────────────────────────────────────────────────

  /**
   * A customer account of the store with a generated password. With
   * `send_credentials` (default) the account_created email carries the
   * password and a magic link on the store's domain. 409 AUTH_EMAIL_EXISTS
   * when the store already has a customer with that email.
   */
  async create(
    store: CustomerStoreScope,
    dto: CreateStoreCustomerDto,
    opts: { enforceDailyLimit?: boolean } = {},
  ) {
    const email = normalizeEmail(dto.email);
    const existing = await this.prisma.user.findFirst({
      where: {
        store_id: store.id,
        email: { equals: email, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (existing) throw emailExists();
    // Checked before the account exists, so a refused request creates nothing.
    if (dto.send_credentials !== false && opts.enforceDailyLimit !== false) {
      await this.assertDailyEmailRoom(store.id, 'account_created');
    }

    const password = generateAccountPassword();
    const password_hash = await bcrypt.hash(password, BCRYPT_COST);
    let user: { id: string; email: string; role: UserRole };
    try {
      user = await this.prisma.user.create({
        data: {
          email,
          password_hash,
          role: UserRole.CUSTOMER,
          status: UserStatus.ACTIVE,
          store_id: store.id,
          customer: {
            create: {
              first_name: dto.first_name ?? '',
              last_name: dto.last_name ?? '',
              phone: dto.phone || null,
            },
          },
        },
        select: { id: true, email: true, role: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw emailExists();
      }
      throw err;
    }

    if (dto.send_credentials !== false) {
      const ctx = await this.links.resolveStore(store.slug);
      // Off the response path; the service never throws and never logs
      // the password.
      void this.credentials.send({
        user,
        name: dto.first_name || null,
        password,
        store: { id: store.id, name: store.name },
        storeBase: ctx?.base ?? null,
        locale: dto.locale ?? ctx?.primaryLocale ?? null,
      });
    }

    const customer = await this.prisma.customer.findUnique({
      where: { user_id: user.id },
      select: { id: true },
    });
    return this.detail(store, customer!.id);
  }

  async update(
    store: CustomerStoreScope,
    customerId: string,
    dto: UpdateStoreCustomerDto,
  ) {
    const customer = await this.findInStore(customerId, store.id);
    const data: Prisma.CustomerUpdateInput = {};
    if (dto.first_name !== undefined) data.first_name = dto.first_name ?? '';
    if (dto.last_name !== undefined) data.last_name = dto.last_name ?? '';
    if (dto.phone !== undefined) data.phone = dto.phone || null;
    if (dto.customer_type !== undefined) {
      data.customer_type = dto.customer_type ?? null;
    }
    if (dto.company_name !== undefined) {
      data.company_name = dto.company_name?.trim().replace(/\s+/g, ' ') || null;
    }
    if (dto.org_number !== undefined) {
      const raw = dto.org_number?.trim() ?? '';
      if (raw) {
        const def = await this.prisma.address.findFirst({
          where: { customer_id: customer.id, is_default: true },
          select: { country_code: true },
        });
        data.org_number = normalizeProfileOrgNumber(
          raw,
          def?.country_code ?? null,
        );
      } else {
        data.org_number = null;
      }
    }
    if (dto.vat_number !== undefined) {
      const raw = dto.vat_number?.trim() ?? '';
      data.vat_number = raw ? normalizeVatNumber(raw) : null;
    }
    if (Object.keys(data).length) {
      await this.prisma.customer.update({ where: { id: customer.id }, data });
    }
    return this.detail(store, customer.id);
  }

  // ── Daily email caps ─────────────────────────────────────────────────────

  /** Emails of `event` the store sent in the last 24 h (EmailLog rows). */
  private async sentLastDay(
    storeId: string,
    event: StoreDailyEmailEvent,
  ): Promise<number> {
    return this.prisma.emailLog.count({
      where: {
        store_id: storeId,
        event,
        created_at: { gte: new Date(Date.now() - DAY_MS) },
      },
    });
  }

  /** How many more `event` emails the store may send today. */
  private async dailyEmailRoom(
    storeId: string,
    event: StoreDailyEmailEvent,
  ): Promise<number> {
    const sent = await this.sentLastDay(storeId, event);
    return Math.max(0, STORE_DAILY_EMAIL_LIMITS[event] - sent);
  }

  /** 429 STORE_DAILY_EMAIL_LIMIT when the store has no room left. */
  private async assertDailyEmailRoom(
    storeId: string,
    event: StoreDailyEmailEvent,
  ): Promise<void> {
    if ((await this.dailyEmailRoom(storeId, event)) <= 0) {
      throw dailyLimit(event);
    }
  }

  // ── Status / emails ──────────────────────────────────────────────────────

  /**
   * Store owner: ACTIVE or SUSPENDED only. BANNED is the platform admin's
   * decision: the owner can neither set it (DTO) nor lift it (403
   * CUSTOMER_BANNED_BY_ADMIN). A block also revokes every token issued so far
   * (User.tokens_valid_after), drops the user's session rows and unused
   * magic links.
   */
  async setStatus(
    store: CustomerStoreScope,
    customerId: string,
    status: CustomerSettableStatus,
  ) {
    const customer = await this.findInStore(customerId, store.id);
    if (customer.user.status === UserStatus.BANNED) throw bannedByAdmin();
    await this.applyStatus(customer.user.id, status);
    return { id: customer.id, user_id: customer.user.id, status };
  }

  private async applyStatus(userId: string, status: CustomerSettableStatus) {
    const blocked = status !== 'ACTIVE';
    await this.prisma.user.update({
      where: { id: userId },
      data: blocked
        ? { status: status as UserStatus, tokens_valid_after: new Date() }
        : { status: status as UserStatus },
    });
    if (blocked) {
      await this.prisma.session.deleteMany({ where: { user_id: userId } });
      await this.magicLinks.invalidateForUser(userId);
    }
  }

  /** A one-time magic login link on the store's domain, by email. */
  async sendLoginLink(store: CustomerStoreScope, customerId: string) {
    const customer = await this.findInStore(customerId, store.id);
    if (customer.user.status !== UserStatus.ACTIVE) throw notActive();
    await this.assertDailyEmailRoom(store.id, 'customer_login_link');
    await this.mailLoginLink(store, customer);
    return { sent: true };
  }

  private async mailLoginLink(
    store: CustomerStoreScope,
    customer: { first_name: string; user: { id: string; email: string } },
  ): Promise<void> {
    const ctx = await this.links.resolveStore(store.slug);
    const raw = await this.magicLinks.issue(customer.user.id, {
      storeId: store.id,
      ttlHours: MAGIC_LINK_TTL_HOURS,
    });
    const locale = ctx?.primaryLocale ?? null;
    const { magicUrl, loginUrl } = this.links.accountLinks(raw, {
      role: UserRole.CUSTOMER,
      storeBase: ctx?.base ?? null,
      locale,
    });
    await this.mail.sendCustomerLoginLink(
      customer.user.email,
      {
        name: customer.first_name?.trim() || '',
        magicUrl,
        loginUrl,
        expiresHours: MAGIC_LINK_TTL_HOURS,
      },
      locale,
      { storeId: store.id, storeName: store.name },
    );
  }

  /**
   * The store-branded password reset email, through the storefront
   * forgot-password flow with this store as the context (the account is
   * looked up by store + email, so it is exactly this customer).
   */
  async sendPasswordReset(store: CustomerStoreScope, customerId: string) {
    const customer = await this.findInStore(customerId, store.id);
    if (customer.user.status !== UserStatus.ACTIVE) throw notActive();
    await this.auth.forgotPassword(customer.user.email, store.slug);
    return { sent: true };
  }

  // ── Bulk ─────────────────────────────────────────────────────────────────

  async bulk(
    store: CustomerStoreScope,
    dto: BulkCustomersDto,
  ): Promise<BulkResult> {
    const ids = [...new Set(dto.ids)];
    const rows = await this.prisma.customer.findMany({
      where: {
        id: { in: ids },
        user: { role: UserRole.CUSTOMER, store_id: store.id },
      },
      select: {
        id: true,
        first_name: true,
        user: { select: { id: true, email: true, status: true } },
      },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const result: BulkResult = {
      action: dto.action,
      requested: ids.length,
      succeeded: [],
      skipped: [],
    };
    // Login links: the remaining daily room is read once and spent locally,
    // so the batch stops exactly at the cap.
    let linkRoom =
      dto.action === 'send-login-link'
        ? await this.dailyEmailRoom(store.id, 'customer_login_link')
        : 0;
    for (const id of ids) {
      const row = byId.get(id);
      if (!row) {
        result.skipped.push({ id, reason: 'not_found' });
        continue;
      }
      try {
        if (dto.action === 'block' || dto.action === 'unblock') {
          // A platform ban is not the owner's to change either way.
          if (row.user.status === UserStatus.BANNED) {
            result.skipped.push({ id, reason: 'banned' });
            continue;
          }
          await this.applyStatus(
            row.user.id,
            dto.action === 'block' ? 'SUSPENDED' : 'ACTIVE',
          );
        } else {
          if (row.user.status !== UserStatus.ACTIVE) {
            result.skipped.push({ id, reason: 'not_active' });
            continue;
          }
          if (linkRoom <= 0) {
            result.skipped.push({ id, reason: 'daily_limit' });
            continue;
          }
          linkRoom -= 1;
          await this.mailLoginLink(store, row);
        }
        result.succeeded.push(id);
      } catch (err) {
        this.logger.warn(
          `Bulk ${dto.action} failed for customer ${id} (${
            err instanceof Error ? err.name : 'unknown error'
          })`,
        );
        result.skipped.push({ id, reason: 'not_found' });
      }
    }
    return result;
  }
}

function emailExists() {
  return new ConflictException({
    code: 'AUTH_EMAIL_EXISTS',
    message: 'A customer with this email already exists in this store.',
  });
}

/** Columns of the customers CSV, in order. */
export const CUSTOMERS_CSV_COLUMNS = [
  'id',
  'email',
  'first_name',
  'last_name',
  'phone',
  'status',
  'customer_type',
  'company_name',
  'orders_count',
  'total_spent',
  'currency',
  'last_order_at',
  'created_at',
] as const;

/**
 * Comma-separated, CRLF lines; text cells pass the formula-injection guard
 * of csvText (leading = + - @ tab CR get a ' prefix) and are quoted when
 * needed. Amounts use the currency's decimals.
 */
export function customersCsv(rows: CustomerListRow[]): string {
  const lines = [CUSTOMERS_CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvText(r.id),
        csvText(r.email),
        csvText(r.first_name),
        csvText(r.last_name),
        csvText(r.phone),
        csvText(r.status),
        csvText(r.customer_type),
        csvText(r.company_name),
        String(r.orders_count),
        csvAmount(r.total_spent, r.currency),
        csvText(r.currency),
        csvText(r.last_order_at),
        csvText(r.created_at),
      ].join(','),
    );
  }
  return lines.join('\r\n') + '\r\n';
}
