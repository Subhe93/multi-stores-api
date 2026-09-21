import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, StoreType, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateTaxClassDto,
  CreateTaxRateDto,
  ListTaxRatesQueryDto,
  TaxReportQueryDto,
  UpdatePlatformTaxSettingsDto,
  UpdateStoreTaxSettingsDto,
  UpdateTaxClassDto,
  UpdateTaxRateDto,
} from './dto/tax.dto';
import { SEED_CLASSES, TAX_LABEL, flattenSeedRates } from './tax-seed';
import { TaxService, taxStoreSelect } from './tax.service';

/**
 * Tax administration (API-CONTRACT-TAX.md §3): classes and rates of one
 * scope (platform = store_id null, or one store), the registrant settings,
 * the default-rate seed and the collected-tax report. The engine itself is
 * TaxService.
 */

/** Which rows a caller may manage: the platform's or one store's. */
export type TaxScope = { store_id: string | null };

export interface TaxReportRow {
  country: string;
  label: string;
  rate_bp: number;
  taxable_amount: number;
  tax_amount: number;
  order_count: number;
  currency: string;
}

const TAX_CLASS_NOT_FOUND = {
  code: 'TAX_CLASS_NOT_FOUND',
  message: 'Tax class not found',
};
const TAX_RATE_NOT_FOUND = {
  code: 'TAX_RATE_NOT_FOUND',
  message: 'Tax rate not found',
};
const TAX_CLASS_DEFAULT_REQUIRED = {
  code: 'TAX_CLASS_DEFAULT_REQUIRED',
  message:
    'Every scope needs exactly one default tax class; make another class the default first.',
};
const TAX_SETTINGS_PLATFORM_MANAGED = {
  code: 'TAX_SETTINGS_PLATFORM_MANAGED',
  message:
    'Taxes of a marketplace store are handled by the platform; there is nothing to configure here.',
};

@Injectable()
export class TaxManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tax: TaxService,
  ) {}

  // ── Scope helpers ─────────────────────────────────────────────────────────

  /** The store owned by a creator user, or 404. */
  async storeOfCreator(userId: string) {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    const store = creator
      ? await this.prisma.store.findUnique({
          where: { creator_id: creator.id },
          select: taxStoreSelect,
        })
      : null;
    if (!store) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    return store;
  }

  /** Classes a caller may pick for a product: platform + own store. */
  async classesForUser(userId: string, role: UserRole) {
    let storeId: string | null = null;
    if (role === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
        select: { store: { select: { id: true } } },
      });
      storeId = creator?.store?.id ?? null;
    }
    return this.prisma.taxClass.findMany({
      where: storeId
        ? { OR: [{ store_id: null }, { store_id: storeId }] }
        : { store_id: null },
      orderBy: [
        { store_id: 'asc' },
        { sort_order: 'asc' },
        { created_at: 'asc' },
      ],
    });
  }

  /**
   * Whether a class may be assigned to a product of `storeId` (null = a
   * provider product): the platform's classes or the store's own.
   */
  async assertClassAssignable(
    classId: string,
    storeId: string | null,
  ): Promise<void> {
    const cls = await this.prisma.taxClass.findUnique({
      where: { id: classId },
      select: { store_id: true },
    });
    if (!cls || (cls.store_id !== null && cls.store_id !== storeId)) {
      throw new BadRequestException({
        code: 'TAX_CLASS_INVALID',
        message: 'The selected tax class is not available for this product.',
      });
    }
  }

  // ── Classes ───────────────────────────────────────────────────────────────

  listClasses(scope: TaxScope) {
    return this.prisma.taxClass.findMany({
      where: { store_id: scope.store_id },
      orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      include: { _count: { select: { rates: true, products: true } } },
    });
  }

  async createClass(scope: TaxScope, dto: CreateTaxClassDto) {
    const existing = await this.prisma.taxClass.findFirst({
      where: { store_id: scope.store_id, key: dto.key },
      select: { id: true },
    });
    if (existing) {
      throw new ConflictException({
        code: 'TAX_CLASS_KEY_TAKEN',
        message: `A tax class with key "${dto.key}" already exists.`,
      });
    }
    return this.prisma.$transaction(async (tx) => {
      // The first class of a scope is its default whatever the caller sent:
      // the engine falls back to the scope default, so one must exist.
      const count = await tx.taxClass.count({
        where: { store_id: scope.store_id },
      });
      const isDefault = count === 0 || dto.is_default === true;
      if (isDefault) await this.clearDefault(tx, scope);
      return tx.taxClass.create({
        data: {
          store_id: scope.store_id,
          key: dto.key,
          name: dto.name,
          is_default: isDefault,
          sort_order: dto.sort_order ?? 0,
        },
      });
    });
  }

  async updateClass(scope: TaxScope, id: string, dto: UpdateTaxClassDto) {
    const cls = await this.findClassInScope(scope, id);
    if (dto.key && dto.key !== cls.key) {
      const taken = await this.prisma.taxClass.findFirst({
        where: { store_id: scope.store_id, key: dto.key, id: { not: id } },
        select: { id: true },
      });
      if (taken) {
        throw new ConflictException({
          code: 'TAX_CLASS_KEY_TAKEN',
          message: `A tax class with key "${dto.key}" already exists.`,
        });
      }
    }
    // The default can only move to another class, never be switched off.
    if (dto.is_default === false && cls.is_default) {
      throw new BadRequestException(TAX_CLASS_DEFAULT_REQUIRED);
    }
    return this.prisma.$transaction(async (tx) => {
      if (dto.is_default) await this.clearDefault(tx, scope);
      return tx.taxClass.update({
        where: { id },
        data: {
          key: dto.key,
          name: dto.name,
          is_default: dto.is_default,
          sort_order: dto.sort_order,
        },
      });
    });
  }

  async deleteClass(scope: TaxScope, id: string) {
    const cls = await this.findClassInScope(scope, id);
    if (cls.is_default) {
      throw new ConflictException(TAX_CLASS_DEFAULT_REQUIRED);
    }
    const [rates, products, stores] = await Promise.all([
      this.prisma.taxRate.count({ where: { tax_class_id: id } }),
      this.prisma.product.count({ where: { tax_class_id: id } }),
      this.prisma.store.count({ where: { shipping_tax_class_id: id } }),
    ]);
    if (rates > 0 || products > 0 || stores > 0) {
      throw new ConflictException({
        code: 'TAX_CLASS_IN_USE',
        message: `This tax class is still used by ${rates} rate(s), ${products} product(s) and ${stores} store shipping setting(s).`,
      });
    }
    await this.prisma.taxClass.delete({ where: { id } });
    return { deleted: true };
  }

  private async findClassInScope(scope: TaxScope, id: string) {
    const cls = await this.prisma.taxClass.findUnique({ where: { id } });
    if (!cls || cls.store_id !== scope.store_id) {
      throw new NotFoundException(TAX_CLASS_NOT_FOUND);
    }
    return cls;
  }

  private async clearDefault(tx: Prisma.TransactionClient, scope: TaxScope) {
    await tx.taxClass.updateMany({
      where: { store_id: scope.store_id, is_default: true },
      data: { is_default: false },
    });
  }

  // ── Rates ─────────────────────────────────────────────────────────────────

  /**
   * Whether a store may manage its own rate rows: only an INDEPENDENT store
   * is a registrant; a marketplace store's rows would never be read.
   */
  storeManagesRates(store: { store_type: StoreType }): boolean {
    return store.store_type === StoreType.INDEPENDENT;
  }

  assertStoreManagesRates(store: { store_type: StoreType }): void {
    if (!this.storeManagesRates(store)) {
      throw new BadRequestException(TAX_SETTINGS_PLATFORM_MANAGED);
    }
  }

  async listRates(scope: TaxScope, query: ListTaxRatesQueryDto = {}) {
    const where: Prisma.TaxRateWhereInput = { store_id: scope.store_id };
    if (query.country) where.country = query.country;
    if (query.class) {
      where.OR = [
        { tax_class_id: query.class },
        { tax_class: { key: query.class } },
      ];
    }
    return this.prisma.taxRate.findMany({
      where,
      orderBy: [
        { country: 'asc' },
        { priority: 'asc' },
        { rate_bp: 'desc' },
        { created_at: 'asc' },
      ],
      include: { tax_class: { select: { id: true, key: true, name: true } } },
    });
  }

  async createRate(scope: TaxScope, dto: CreateTaxRateDto) {
    await this.assertClassVisible(scope, dto.tax_class_id);
    return this.prisma.taxRate.create({
      data: {
        store_id: scope.store_id,
        tax_class_id: dto.tax_class_id,
        country: dto.country,
        region: dto.region ?? null,
        postcode_pattern: dto.postcode_pattern ?? null,
        rate_bp: dto.rate_bp,
        label: dto.label,
        priority: dto.priority ?? 0,
        applies_to_shipping: dto.applies_to_shipping ?? true,
        is_active: dto.is_active ?? true,
      },
      include: { tax_class: { select: { id: true, key: true, name: true } } },
    });
  }

  async updateRate(scope: TaxScope, id: string, dto: UpdateTaxRateDto) {
    await this.findRateInScope(scope, id);
    if (dto.tax_class_id)
      await this.assertClassVisible(scope, dto.tax_class_id);
    return this.prisma.taxRate.update({
      where: { id },
      data: {
        tax_class_id: dto.tax_class_id,
        country: dto.country,
        region: dto.region,
        postcode_pattern: dto.postcode_pattern,
        rate_bp: dto.rate_bp,
        label: dto.label,
        priority: dto.priority,
        applies_to_shipping: dto.applies_to_shipping,
        is_active: dto.is_active,
      },
      include: { tax_class: { select: { id: true, key: true, name: true } } },
    });
  }

  async deleteRate(scope: TaxScope, id: string) {
    await this.findRateInScope(scope, id);
    await this.prisma.taxRate.delete({ where: { id } });
    return { deleted: true };
  }

  private async findRateInScope(scope: TaxScope, id: string) {
    const rate = await this.prisma.taxRate.findUnique({ where: { id } });
    if (!rate || rate.store_id !== scope.store_id) {
      throw new NotFoundException(TAX_RATE_NOT_FOUND);
    }
    return rate;
  }

  /** A rate may reference a platform class or a class of its own scope. */
  private async assertClassVisible(scope: TaxScope, classId: string) {
    const cls = await this.prisma.taxClass.findUnique({
      where: { id: classId },
      select: { store_id: true },
    });
    if (!cls || (cls.store_id !== null && cls.store_id !== scope.store_id)) {
      throw new BadRequestException({
        code: 'TAX_CLASS_INVALID',
        message: 'The selected tax class is not available in this scope.',
      });
    }
  }

  // ── Seed ──────────────────────────────────────────────────────────────────

  /**
   * Idempotent seed of the platform classes and the default country rates
   * (tax-seed.ts). Existing rows for the same (class, country) with no
   * region/postcode are updated, everything else is left alone.
   */
  async seedPlatformRates() {
    const classIds = new Map<string, string>();
    let created = 0;
    let updated = 0;

    await this.prisma.$transaction(async (tx) => {
      for (const cls of SEED_CLASSES) {
        const existing = await tx.taxClass.findFirst({
          where: { store_id: null, key: cls.key },
          select: { id: true },
        });
        if (existing) {
          classIds.set(cls.key, existing.id);
          continue;
        }
        const hasDefault = cls.is_default
          ? await tx.taxClass.findFirst({
              where: { store_id: null, is_default: true },
              select: { id: true },
            })
          : null;
        const row = await tx.taxClass.create({
          data: {
            store_id: null,
            key: cls.key,
            name: cls.name,
            is_default: cls.is_default && !hasDefault,
            sort_order: cls.sort_order,
          },
        });
        classIds.set(cls.key, row.id);
      }

      for (const seed of flattenSeedRates()) {
        const classId = classIds.get(seed.class_key);
        if (!classId) continue;
        const existing = await tx.taxRate.findFirst({
          where: {
            store_id: null,
            tax_class_id: classId,
            country: seed.country,
            region: null,
            postcode_pattern: null,
          },
          select: { id: true, rate_bp: true },
        });
        if (existing) {
          if (existing.rate_bp !== seed.rate_bp) {
            await tx.taxRate.update({
              where: { id: existing.id },
              data: { rate_bp: seed.rate_bp, label: TAX_LABEL },
            });
            updated += 1;
          }
          continue;
        }
        await tx.taxRate.create({
          data: {
            store_id: null,
            tax_class_id: classId,
            country: seed.country,
            rate_bp: seed.rate_bp,
            label: TAX_LABEL,
            priority: 0,
            applies_to_shipping: true,
            is_active: true,
          },
        });
        created += 1;
      }

      const config = await tx.platformConfig.findFirst({
        select: { id: true },
      });
      if (config) {
        await tx.platformConfig.update({
          where: { id: config.id },
          data: { tax_rates_seeded_at: new Date() },
        });
      } else {
        await tx.platformConfig.create({
          data: { tax_rates_seeded_at: new Date() },
        });
      }
    });

    return { created, updated, seeded_at: new Date().toISOString() };
  }

  // ── Settings ──────────────────────────────────────────────────────────────

  private readonly platformSettingsSelect = {
    default_tax_pricing_mode: true,
    platform_tax_country: true,
    platform_oss_registered: true,
    tax_rates_seeded_at: true,
  } as const;

  async getPlatformSettings() {
    const config = await this.prisma.platformConfig.findFirst({
      select: this.platformSettingsSelect,
    });
    const [classes, ratesCount] = await Promise.all([
      this.listClasses({ store_id: null }),
      this.prisma.taxRate.count({ where: { store_id: null } }),
    ]);
    return {
      default_tax_pricing_mode: config?.default_tax_pricing_mode ?? 'INCLUSIVE',
      platform_tax_country: config?.platform_tax_country ?? null,
      platform_oss_registered: config?.platform_oss_registered ?? false,
      tax_rates_seeded_at: config?.tax_rates_seeded_at ?? null,
      classes,
      platform_rates_count: ratesCount,
    };
  }

  async updatePlatformSettings(dto: UpdatePlatformTaxSettingsDto) {
    const data: Prisma.PlatformConfigUpdateInput = {};
    if (dto.default_tax_pricing_mode !== undefined) {
      data.default_tax_pricing_mode = dto.default_tax_pricing_mode;
    }
    if (dto.platform_tax_country !== undefined) {
      data.platform_tax_country = dto.platform_tax_country || null;
    }
    if (dto.platform_oss_registered !== undefined) {
      data.platform_oss_registered = dto.platform_oss_registered;
    }
    const config = await this.prisma.platformConfig.findFirst({
      select: { id: true },
    });
    if (config) {
      await this.prisma.platformConfig.update({
        where: { id: config.id },
        data,
      });
    } else {
      await this.prisma.platformConfig.create({
        data: data as Prisma.PlatformConfigCreateInput,
      });
    }
    return this.getPlatformSettings();
  }

  async getStoreSettings(userId: string) {
    const store = await this.storeOfCreator(userId);
    const ctx = await this.tax.contextFor(store);
    const [classes, platformRatesCount, storeRatesCount] = await Promise.all([
      this.prisma.taxClass.findMany({
        where: { OR: [{ store_id: null }, { store_id: store.id }] },
        orderBy: [
          { store_id: 'asc' },
          { sort_order: 'asc' },
          { created_at: 'asc' },
        ],
      }),
      this.prisma.taxRate.count({ where: { store_id: null, is_active: true } }),
      this.countActiveStoreRates(store.id),
    ]);
    return {
      registrant: ctx.registrant,
      store_type: store.store_type,
      // The effective settings (platform's for a marketplace store).
      pricing_mode: ctx.pricingMode,
      basis: ctx.basis,
      // What the store stored (null = inherit) vs. what the engine resolves:
      // a marketplace store stores nothing, the platform country applies.
      tax_country: ctx.registrant === 'STORE' ? store.tax_country : null,
      effective_tax_country: ctx.taxCountry,
      oss_registered: ctx.ossRegistered,
      use_platform_tax_rates: ctx.usePlatformRates,
      shipping_tax_class_id: ctx.shippingTaxClassId,
      display_prices_incl_tax: store.display_prices_incl_tax,
      classes,
      platform_rates_count: platformRatesCount,
      store_rates_count: storeRatesCount,
    };
  }

  private countActiveStoreRates(storeId: string) {
    return this.prisma.taxRate.count({
      where: { store_id: storeId, is_active: true },
    });
  }

  async updateStoreSettings(userId: string, dto: UpdateStoreTaxSettingsDto) {
    const store = await this.storeOfCreator(userId);
    this.assertStoreManagesRates(store);
    // Turning the platform rates off with no own rates would silently tax
    // nothing.
    if (dto.use_platform_tax_rates === false) {
      const own = await this.countActiveStoreRates(store.id);
      if (own === 0) {
        throw new BadRequestException({
          code: 'TAX_STORE_RATES_REQUIRED',
          message:
            'Add at least one active tax rate of your own before switching the platform rates off.',
        });
      }
    }
    if (dto.shipping_tax_class_id) {
      await this.assertClassVisible(
        { store_id: store.id },
        dto.shipping_tax_class_id,
      );
    }
    const data: Prisma.StoreUpdateInput = {};
    if (dto.pricing_mode !== undefined)
      data.tax_pricing_mode = dto.pricing_mode;
    if (dto.basis !== undefined) data.tax_basis = dto.basis;
    if (dto.tax_country !== undefined)
      data.tax_country = dto.tax_country || null;
    if (dto.oss_registered !== undefined)
      data.oss_registered = dto.oss_registered;
    if (dto.use_platform_tax_rates !== undefined) {
      data.use_platform_tax_rates = dto.use_platform_tax_rates;
    }
    if (dto.shipping_tax_class_id !== undefined) {
      data.shipping_tax_class_id = dto.shipping_tax_class_id || null;
    }
    if (dto.display_prices_incl_tax !== undefined) {
      data.display_prices_incl_tax = dto.display_prices_incl_tax;
    }
    await this.prisma.store.update({ where: { id: store.id }, data });
    return this.getStoreSettings(userId);
  }

  // ── Report ────────────────────────────────────────────────────────────────

  /**
   * Tax collected on paid orders in [from, to] (inclusive days, UTC), by
   * expanding each order's tax_lines. Rows are keyed by destination
   * country, label, rate and currency.
   */
  async report(
    query: TaxReportQueryDto,
    scope: { store_id?: string | null },
  ): Promise<TaxReportRow[]> {
    const from = new Date(`${query.from}T00:00:00.000Z`);
    const to = new Date(`${query.to ?? query.from}T23:59:59.999Z`);
    if (
      Number.isNaN(from.getTime()) ||
      Number.isNaN(to.getTime()) ||
      from > to
    ) {
      throw new BadRequestException({
        code: 'TAX_REPORT_RANGE_INVALID',
        message: 'from must be a date on or before to.',
      });
    }
    const where: Prisma.OrderWhereInput = {
      payment_status: 'paid',
      created_at: { gte: from, lte: to },
      tax_lines: { not: Prisma.DbNull },
    };
    if (scope.store_id) where.store_id = scope.store_id;

    const orders = await this.prisma.order.findMany({
      where,
      select: {
        id: true,
        currency: true,
        tax_basis_country: true,
        tax_lines: true,
        address: { select: { country_code: true } },
      },
    });

    const rows = new Map<string, TaxReportRow & { orders: Set<string> }>();
    for (const order of orders) {
      const lines = Array.isArray(order.tax_lines)
        ? (order.tax_lines as unknown[])
        : [];
      const country = (
        order.tax_basis_country ??
        order.address?.country_code ??
        ''
      ).toUpperCase();
      for (const raw of lines) {
        if (!raw || typeof raw !== 'object') continue;
        const line = raw as Record<string, unknown>;
        const label = typeof line.label === 'string' ? line.label : 'Tax';
        const rateBp = Math.trunc(Number(line.rate_bp) || 0);
        const key = `${country}|${label}|${rateBp}|${order.currency}`;
        const row = rows.get(key) ?? {
          country,
          label,
          rate_bp: rateBp,
          taxable_amount: 0,
          tax_amount: 0,
          order_count: 0,
          currency: order.currency,
          orders: new Set<string>(),
        };
        row.taxable_amount += Number(line.taxable_amount) || 0;
        row.tax_amount += Number(line.tax_amount) || 0;
        row.orders.add(order.id);
        rows.set(key, row);
      }
    }
    return Array.from(rows.values())
      .map(({ orders: ids, ...row }) => ({
        ...row,
        taxable_amount: Math.round(row.taxable_amount * 100) / 100,
        tax_amount: Math.round(row.tax_amount * 100) / 100,
        order_count: ids.size,
      }))
      .sort(
        (a, b) =>
          a.country.localeCompare(b.country) ||
          b.rate_bp - a.rate_bp ||
          a.label.localeCompare(b.label) ||
          a.currency.localeCompare(b.currency),
      );
  }

  toCsv(rows: TaxReportRow[]): string {
    const esc = (v: string | number) => {
      let s = String(v);
      // Formula injection: a cell starting with =, +, -, @, tab or CR would
      // be evaluated by spreadsheet apps; a leading apostrophe forces text.
      if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = [
      'country',
      'label',
      'rate_bp',
      'taxable_amount',
      'tax_amount',
      'order_count',
      'currency',
    ];
    const body = rows.map((r) =>
      [
        r.country,
        r.label,
        r.rate_bp,
        r.taxable_amount.toFixed(2),
        r.tax_amount.toFixed(2),
        r.order_count,
        r.currency,
      ]
        .map(esc)
        .join(','),
    );
    return [header.join(','), ...body].join('\r\n') + '\r\n';
  }
}
