import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { StoreType, TaxBasis, TaxPricingMode } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { currencyDecimals } from '../../common/money/currency.util';
import {
  MAX_RATE_BP,
  addedTaxMinor,
  allocateLargestRemainder,
  clampRateBp,
  roundSymmetric,
} from '../../common/money/tax.util';
import { isEuCountry } from './tax-territory';

/**
 * Tax engine (API-CONTRACT-TAX.md §2). Two halves:
 *
 * - the pure functions (`resolveRatesForLine`, `computeTaxes`) take an
 *   already-loaded context + rate table and never touch the database, so
 *   they are unit-tested directly and give identical numbers to every
 *   caller (cart estimate, quote, order creation, Kustom session);
 * - the injectable service loads the context and rates for a store.
 *
 * Amounts are computed in minor units, rounded per line, then summed —
 * what Kustom validates line by line — and returned in major units.
 */

export type TaxRegistrant = 'STORE' | 'PLATFORM';

/** Everything the resolution needs to know about who is taxing an order. */
export interface TaxContext {
  registrant: TaxRegistrant;
  storeId: string;
  /** The store whose own TaxRate rows apply; null = platform rows only. */
  rateStoreId: string | null;
  /** Registration country (ISO2); null = nothing is ever taxed. */
  taxCountry: string | null;
  pricingMode: TaxPricingMode;
  basis: TaxBasis;
  ossRegistered: boolean;
  usePlatformRates: boolean;
  shippingTaxClassId: string | null;
  displayPricesInclTax: boolean;
}

export interface TaxClassRow {
  id: string;
  store_id: string | null;
  key: string;
  name: unknown;
  is_default: boolean;
}

export interface TaxRateRow {
  id: string;
  store_id: string | null;
  tax_class_id: string;
  country: string;
  region: string | null;
  postcode_pattern: string | null;
  rate_bp: number;
  label: unknown;
  priority: number;
  applies_to_shipping: boolean;
  is_active: boolean;
}

/** Rates and classes visible to one context. */
export interface TaxData {
  rates: TaxRateRow[];
  classes: TaxClassRow[];
}

export interface TaxDestination {
  country: string | null;
  region?: string | null;
  postcode?: string | null;
}

/** One order line as the engine sees it (line total in major units). */
export interface TaxLineInput {
  amount: number;
  tax_class_id: string | null;
  tax_exempt: boolean;
}

export interface TaxComputeInput {
  ctx: TaxContext;
  data: TaxData;
  currency: string;
  /** Locale of the tax labels ('sv' → "Moms"); falls back to 'en'. */
  locale?: string | null;
  lines: TaxLineInput[];
  shipping_cost: number;
  discount_amount: number;
  /** Shipping address; null before it is known (registration country). */
  shipping?: TaxDestination | null;
  /** Billing address (basis BILLING); falls back to the shipping one. */
  billing?: TaxDestination | null;
}

/** One row of the itemized breakdown (major units, order currency). */
export interface TaxLine {
  label: string;
  rate_bp: number;
  taxable_amount: number;
  tax_amount: number;
}

export interface TaxComputeItem {
  tax_rate_bp: number;
  tax_amount: number;
  tax_class_key: string | null;
  /** Share of the order discount allocated to this line (major units). */
  discount_allocated: number;
  /** What the customer pays for the line after discount and tax. */
  gross: number;
}

export interface TaxComputeResult {
  items: TaxComputeItem[];
  shipping_tax_amount: number;
  shipping_tax_rate_bp: number;
  tax_lines: TaxLine[];
  tax_total: number;
  /** Order total: Σ gross + shipping (+ shipping tax in EXCLUSIVE mode). */
  total: number;
  /** Highest rate applied on the order (basis points). */
  headline_rate_bp: number;
  tax_pricing_mode: TaxPricingMode;
  tax_basis_country: string | null;
}

// ── Matching ────────────────────────────────────────────────────────────────

function norm(value: string | null | undefined): string {
  return (value ?? '').trim().toUpperCase();
}

function normPostcode(value: string | null | undefined): string {
  return norm(value).replace(/\s+/g, '');
}

/**
 * Postcode patterns: exact ("11435"), prefix ("114*") or range
 * ("10000-19999", numeric when both ends are, else lexicographic).
 */
export function postcodeMatches(
  pattern: string | null | undefined,
  postcode: string | null | undefined,
): boolean {
  const p = normPostcode(pattern);
  if (!p) return true;
  const code = normPostcode(postcode);
  if (!code) return false;
  if (p.endsWith('*')) return code.startsWith(p.slice(0, -1));
  const range = p.match(/^([^-]+)-([^-]+)$/);
  if (range) {
    const [, lo, hi] = range;
    if (/^\d+$/.test(lo) && /^\d+$/.test(hi) && /^\d+$/.test(code)) {
      const n = Number(code);
      return n >= Number(lo) && n <= Number(hi);
    }
    return code >= lo && code <= hi;
  }
  return code === p;
}

/** Specificity of a rate row: postcode (2) > region (1) > country (0). */
function specificity(rate: TaxRateRow): number {
  if (rate.postcode_pattern) return 2;
  if (rate.region) return 1;
  return 0;
}

function scopeKey(rate: TaxRateRow): string {
  return `${norm(rate.country)}|${rate.tax_class_id}|${norm(rate.region)}|${normPostcode(rate.postcode_pattern)}`;
}

function rateOrder(a: TaxRateRow, b: TaxRateRow): number {
  return a.rate_bp - b.rate_bp || a.id.localeCompare(b.id);
}

/**
 * The rates of one class for one destination country/region/postcode:
 * most specific match wins, then the lowest priority; every rate sharing
 * that priority is returned (they stack). A store row shadows the platform
 * row with the same country + class + region + postcode.
 */
function matchClassRates(
  rates: TaxRateRow[],
  classId: string,
  country: string,
  region: string | null | undefined,
  postcode: string | null | undefined,
): TaxRateRow[] {
  const candidates = rates.filter(
    (r) =>
      r.is_active &&
      r.tax_class_id === classId &&
      norm(r.country) === country &&
      (!r.region || norm(r.region) === norm(region)) &&
      postcodeMatches(r.postcode_pattern, postcode),
  );
  if (candidates.length === 0) return [];

  const storeKeys = new Set(
    candidates.filter((r) => r.store_id).map((r) => scopeKey(r)),
  );
  const unshadowed = candidates.filter(
    (r) => r.store_id || !storeKeys.has(scopeKey(r)),
  );

  const best = Math.max(...unshadowed.map(specificity));
  const atBest = unshadowed.filter((r) => specificity(r) === best);
  const lowest = Math.min(...atBest.map((r) => r.priority));
  return atBest.filter((r) => r.priority === lowest).sort(rateOrder);
}

function defaultClassOf(
  classes: TaxClassRow[],
  storeId: string | null,
): TaxClassRow | null {
  return (
    (storeId && classes.find((c) => c.store_id === storeId && c.is_default)) ||
    classes.find((c) => c.store_id === null && c.is_default) ||
    null
  );
}

export interface ResolvedLineRates {
  rates: TaxRateRow[];
  /** Key of the class the rates were found for (null when exempt / none). */
  class_key: string | null;
  /** The class the line was resolved with, before any fallback. */
  class_id: string | null;
}

/**
 * Rates applying to one line (contract §2, steps 1–4).
 * `forShipping` keeps only rates flagged applies_to_shipping.
 */
export function resolveRatesForLine(
  ctx: TaxContext,
  data: TaxData,
  line: { tax_class_id: string | null; tax_exempt: boolean },
  destination: TaxDestination | null | undefined,
  opts: { forShipping?: boolean } = {},
): ResolvedLineRates {
  const none = (classKey: string | null, classId: string | null) => ({
    rates: [],
    class_key: classKey,
    class_id: classId,
  });

  // 1. Class: the product's, else the scope default. Exempt / zero → 0 %.
  const scopeDefault = defaultClassOf(data.classes, ctx.rateStoreId);
  const cls =
    (line.tax_class_id &&
      data.classes.find((c) => c.id === line.tax_class_id)) ||
    scopeDefault;
  const classKey = cls?.key ?? null;
  const classId = cls?.id ?? null;
  if (line.tax_exempt || !cls || cls.key === 'zero') {
    return none(classKey, classId);
  }

  // 2. Registration and destination country.
  const registration = norm(ctx.taxCountry);
  if (!registration) return none(classKey, classId);
  const destCountry = norm(destination?.country) || registration;

  // 3. Territory: exports are 0 %; inside the EU the OSS flag decides whose
  //    rates apply for a foreign destination.
  let rateCountry: string;
  if (isEuCountry(registration)) {
    if (!isEuCountry(destCountry)) return none(classKey, classId);
    rateCountry =
      destCountry !== registration && !ctx.ossRegistered
        ? registration
        : destCountry;
  } else {
    if (destCountry !== registration) return none(classKey, classId);
    rateCountry = registration;
  }
  // Region / postcode only narrow the destination's own rates.
  const region = rateCountry === destCountry ? destination?.region : null;
  const postcode = rateCountry === destCountry ? destination?.postcode : null;

  // 4. Match, falling back to the scope's default class.
  const visible = data.rates.filter(
    (r) =>
      (r.store_id === null && ctx.usePlatformRates) ||
      (ctx.rateStoreId !== null && r.store_id === ctx.rateStoreId),
  );
  let matched = matchClassRates(visible, cls.id, rateCountry, region, postcode);
  if (matched.length === 0 && scopeDefault && scopeDefault.id !== cls.id) {
    matched = matchClassRates(
      visible,
      scopeDefault.id,
      rateCountry,
      region,
      postcode,
    );
  }
  if (opts.forShipping) matched = matched.filter((r) => r.applies_to_shipping);
  return { rates: matched, class_key: classKey, class_id: classId };
}

// ── Amounts ─────────────────────────────────────────────────────────────────

/** Combined rate of stacked (compound) rates, in basis points. */
export function effectiveRateBp(rates: { rate_bp: number }[]): number {
  if (rates.length === 0) return 0;
  if (rates.length === 1) return clampRateBp(rates[0].rate_bp);
  let factor = 1;
  for (const r of rates) factor *= 1 + clampRateBp(r.rate_bp) / MAX_RATE_BP;
  return Math.round((factor - 1) * MAX_RATE_BP);
}

interface AppliedRate {
  rate: TaxRateRow;
  taxable_minor: number;
  tax_minor: number;
}

/**
 * Tax of one line in minor units. `base` is the line amount after the
 * discount share: the gross in INCLUSIVE mode, the net in EXCLUSIVE mode.
 * Stacked rates compound in ascending order (each on amount + previous
 * taxes). Inclusive: the total tax is `base - base / Π(1 + r)` rounded once,
 * then split per rate so the parts sum to it exactly.
 */
function taxLineMinor(
  base: number,
  rates: TaxRateRow[],
  mode: TaxPricingMode,
): { net: number; tax: number; applied: AppliedRate[] } {
  if (rates.length === 0 || base === 0) {
    return { net: base, tax: 0, applied: [] };
  }
  let net = base;
  if (mode === TaxPricingMode.INCLUSIVE) {
    let factor = 1;
    for (const r of rates) factor *= 1 + clampRateBp(r.rate_bp) / MAX_RATE_BP;
    const tax = roundSymmetric(base - base / factor);
    net = base - tax;
  }
  const applied: AppliedRate[] = [];
  let running = net;
  for (const rate of rates) {
    const t = addedTaxMinor(running, rate.rate_bp);
    applied.push({ rate, taxable_minor: running, tax_minor: t });
    running += t;
  }
  let tax = applied.reduce((s, a) => s + a.tax_minor, 0);
  if (mode === TaxPricingMode.INCLUSIVE) {
    // Per-rate rounding may drift from the single rounding above by a unit;
    // the last rate absorbs it so gross - net stays the line tax.
    const target = base - net;
    const drift = target - tax;
    if (drift !== 0 && applied.length) {
      applied[applied.length - 1].tax_minor += drift;
      tax = target;
    }
  }
  return { net, tax, applied };
}

function pickLabel(label: unknown, locale: string | null | undefined): string {
  if (typeof label === 'string') return label;
  if (!label || typeof label !== 'object') return 'Tax';
  const map = label as Record<string, unknown>;
  const lang = (locale ?? 'en').toLowerCase().split(/[-_]/)[0];
  const pick = (k: string): string | null => {
    const v = map[k];
    return typeof v === 'string' && v.trim() ? v : null;
  };
  const any = Object.values(map).find(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );
  return pick(lang) ?? pick('en') ?? any ?? 'Tax';
}

function destinationFor(
  ctx: TaxContext,
  input: Pick<TaxComputeInput, 'shipping' | 'billing'>,
): TaxDestination | null {
  switch (ctx.basis) {
    case TaxBasis.BILLING:
      return input.billing ?? input.shipping ?? null;
    case TaxBasis.STORE:
      return { country: ctx.taxCountry };
    default:
      return input.shipping ?? null;
  }
}

/**
 * Full tax computation for an order (contract §2 "Amounts"): allocate the
 * discount across the product lines, tax each line and the shipping,
 * group the breakdown by (label, rate) and derive the totals.
 */
export function computeTaxes(input: TaxComputeInput): TaxComputeResult {
  const { ctx, data } = input;
  const mode = ctx.pricingMode;
  const factor = 10 ** currencyDecimals(input.currency);
  const toMinor = (major: unknown) => Math.round(Number(major || 0) * factor);
  const toMajor = (minor: number) => minor / factor;

  const destination = destinationFor(ctx, input);
  const basisCountry =
    norm(destination?.country) || norm(ctx.taxCountry) || null;

  // Discount share per line (largest remainder keeps the sum exact).
  const lineMinor = input.lines.map((l) => toMinor(l.amount));
  const discountMinor = Math.min(
    toMinor(input.discount_amount),
    lineMinor.reduce((s, x) => s + x, 0),
  );
  const shares = allocateLargestRemainder(discountMinor, lineMinor);

  const groups = new Map<
    string,
    { label: string; rate_bp: number; taxable: number; tax: number }
  >();
  const addToGroup = (applied: AppliedRate[]) => {
    for (const a of applied) {
      const label = pickLabel(a.rate.label, input.locale);
      const rateBp = clampRateBp(a.rate.rate_bp);
      const key = `${label}|${rateBp}`;
      const g = groups.get(key) ?? {
        label,
        rate_bp: rateBp,
        taxable: 0,
        tax: 0,
      };
      g.taxable += a.taxable_minor;
      g.tax += a.tax_minor;
      groups.set(key, g);
    }
  };

  let headline = 0;
  let taxTotalMinor = 0;
  let grossSumMinor = 0;
  let highest: { rate_bp: number; class_id: string | null } | null = null;
  const items: TaxComputeItem[] = input.lines.map((line, i) => {
    const resolved = resolveRatesForLine(ctx, data, line, destination);
    const base = lineMinor[i] - shares[i];
    const { tax, applied } = taxLineMinor(base, resolved.rates, mode);
    const rateBp = effectiveRateBp(resolved.rates);
    addToGroup(applied);
    taxTotalMinor += tax;
    const gross = mode === TaxPricingMode.INCLUSIVE ? base : base + tax;
    grossSumMinor += gross;
    headline = Math.max(headline, rateBp);
    if (resolved.rates.length && (!highest || rateBp > highest.rate_bp)) {
      highest = { rate_bp: rateBp, class_id: resolved.class_id };
    }
    return {
      tax_rate_bp: rateBp,
      tax_amount: toMajor(tax),
      tax_class_key: resolved.class_key,
      discount_allocated: toMajor(shares[i]),
      gross: toMajor(gross),
    };
  });

  // Shipping: the configured class, else the class of the highest-rate line.
  const shippingMinor = toMinor(input.shipping_cost);
  let shippingTaxMinor = 0;
  let shippingRateBp = 0;
  const shippingClassId =
    ctx.shippingTaxClassId ??
    (highest as { class_id: string | null } | null)?.class_id ??
    null;
  // The rate is resolved even for free shipping: a Kustom session prices
  // every offered option with it, not only the selected (possibly free) one.
  if (shippingClassId) {
    const resolved = resolveRatesForLine(
      ctx,
      data,
      { tax_class_id: shippingClassId, tax_exempt: false },
      destination,
      { forShipping: true },
    );
    shippingRateBp = effectiveRateBp(resolved.rates);
    if (shippingMinor > 0) {
      const { tax, applied } = taxLineMinor(
        shippingMinor,
        resolved.rates,
        mode,
      );
      addToGroup(applied);
      shippingTaxMinor = tax;
      taxTotalMinor += tax;
      headline = Math.max(headline, shippingRateBp);
    }
  }

  const totalMinor =
    grossSumMinor +
    shippingMinor +
    (mode === TaxPricingMode.EXCLUSIVE ? shippingTaxMinor : 0);

  const tax_lines: TaxLine[] = Array.from(groups.values())
    .sort((a, b) => b.rate_bp - a.rate_bp || a.label.localeCompare(b.label))
    .map((g) => ({
      label: g.label,
      rate_bp: g.rate_bp,
      taxable_amount: toMajor(g.taxable),
      tax_amount: toMajor(g.tax),
    }));

  return {
    items,
    shipping_tax_amount: toMajor(shippingTaxMinor),
    shipping_tax_rate_bp: shippingRateBp,
    tax_lines,
    tax_total: toMajor(taxTotalMinor),
    total: toMajor(totalMinor),
    headline_rate_bp: headline,
    tax_pricing_mode: mode,
    tax_basis_country: basisCountry,
  };
}

// ── Service ─────────────────────────────────────────────────────────────────

/** Store columns the context is built from. */
export const taxStoreSelect = {
  id: true,
  store_type: true,
  tax_pricing_mode: true,
  tax_basis: true,
  tax_country: true,
  oss_registered: true,
  use_platform_tax_rates: true,
  shipping_tax_class_id: true,
  display_prices_incl_tax: true,
} as const;

export interface TaxStoreFields {
  id: string;
  store_type: StoreType;
  tax_pricing_mode: TaxPricingMode;
  tax_basis: TaxBasis;
  tax_country: string | null;
  oss_registered: boolean;
  use_platform_tax_rates: boolean;
  shipping_tax_class_id: string | null;
  display_prices_incl_tax: boolean;
}

export interface TaxPlatformFields {
  default_tax_pricing_mode: TaxPricingMode;
  platform_tax_country: string | null;
  platform_oss_registered: boolean;
}

/**
 * Who taxes this store's orders. INDEPENDENT: the store, with its own
 * settings and rates (plus the platform's when it opted in). MARKETPLACE:
 * the platform — its settings, its rates only; the store's tax settings
 * are ignored entirely.
 */
export function buildTaxContext(
  store: TaxStoreFields,
  platform: TaxPlatformFields | null,
): TaxContext {
  if (store.store_type === StoreType.INDEPENDENT) {
    return {
      registrant: 'STORE',
      storeId: store.id,
      rateStoreId: store.id,
      taxCountry:
        norm(store.tax_country) || norm(platform?.platform_tax_country) || null,
      pricingMode: store.tax_pricing_mode,
      basis: store.tax_basis,
      ossRegistered: store.oss_registered,
      usePlatformRates: store.use_platform_tax_rates,
      shippingTaxClassId: store.shipping_tax_class_id,
      displayPricesInclTax: store.display_prices_incl_tax,
    };
  }
  return {
    registrant: 'PLATFORM',
    storeId: store.id,
    rateStoreId: null,
    taxCountry: norm(platform?.platform_tax_country) || null,
    pricingMode: platform?.default_tax_pricing_mode ?? TaxPricingMode.INCLUSIVE,
    basis: TaxBasis.SHIPPING,
    ossRegistered: platform?.platform_oss_registered ?? false,
    usePlatformRates: true,
    shippingTaxClassId: null,
    displayPricesInclTax: store.display_prices_incl_tax,
  };
}

@Injectable()
export class TaxService implements OnModuleInit {
  private readonly logger = new Logger(TaxService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Startup sanity check: a store whose active rate rows can never resolve
   * because its effective registration country is null (an INDEPENDENT
   * store with no tax_country and no platform country, or a MARKETPLACE
   * store while the platform country is unset) taxes nothing. Logged, never
   * thrown — a missing table (migration not applied yet) must not stop the
   * app.
   */
  async onModuleInit(): Promise<void> {
    try {
      const [platform, stores] = await Promise.all([
        this.prisma.platformConfig.findFirst({
          select: {
            default_tax_pricing_mode: true,
            platform_tax_country: true,
            platform_oss_registered: true,
          },
        }),
        this.prisma.store.findMany({
          where: { tax_rates: { some: { is_active: true } } },
          select: { ...taxStoreSelect, slug: true },
        }),
      ]);
      const unresolved = stores.filter(
        (s) => buildTaxContext(s, platform).taxCountry === null,
      );
      if (unresolved.length) {
        this.logger.warn(
          `${unresolved.length} store(s) have active tax rates but no effective registration country (their rates never apply): ${unresolved
            .map((s) => `${s.slug} [${s.store_type}]`)
            .join(', ')}`,
        );
      }
    } catch (err) {
      this.logger.debug(
        `Tax registration check skipped: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** The tax context of a store (contract §2 scope rules). */
  async resolveStoreTaxContext(storeId: string): Promise<TaxContext> {
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: taxStoreSelect,
    });
    if (!store) {
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    }
    return this.contextFor(store);
  }

  /** Same as resolveStoreTaxContext for an already-loaded store row. */
  async contextFor(store: TaxStoreFields): Promise<TaxContext> {
    const platform = await this.prisma.platformConfig.findFirst({
      select: {
        default_tax_pricing_mode: true,
        platform_tax_country: true,
        platform_oss_registered: true,
      },
    });
    return buildTaxContext(store, platform);
  }

  /**
   * Active rates and classes visible to a context: platform rows (when the
   * context uses them) plus the store's own rows. Classes of both scopes
   * are always loaded so a product's class key can be reported even when
   * no rate matches it.
   */
  async loadTaxData(ctx: TaxContext): Promise<TaxData> {
    const scopes: ({ store_id: string } | { store_id: null })[] = [];
    if (ctx.usePlatformRates) scopes.push({ store_id: null });
    if (ctx.rateStoreId) scopes.push({ store_id: ctx.rateStoreId });
    const [rates, classes] = await Promise.all([
      scopes.length
        ? this.prisma.taxRate.findMany({
            where: { is_active: true, OR: scopes },
          })
        : Promise.resolve([]),
      this.prisma.taxClass.findMany({
        where: { OR: [{ store_id: null }, { store_id: ctx.storeId }] },
        orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
      }),
    ]);
    return { rates, classes };
  }

  /** Pure computation, exposed on the service for injection-friendly callers. */
  computeTaxes(input: TaxComputeInput): TaxComputeResult {
    return computeTaxes(input);
  }

  /** Context + data + computation for a store in one call. */
  async computeForStore(
    storeId: string,
    input: Omit<TaxComputeInput, 'ctx' | 'data'>,
  ): Promise<{ ctx: TaxContext; result: TaxComputeResult }> {
    const ctx = await this.resolveStoreTaxContext(storeId);
    const data = await this.loadTaxData(ctx);
    return { ctx, result: computeTaxes({ ...input, ctx, data }) };
  }
}
