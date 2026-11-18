import { StoreStatus, StoreType } from '@prisma/client';
import { StorefrontService } from '../storefront.service';
import { PrismaService } from '../../../prisma/prisma.service';
import { StoreAppsService } from '../../store-apps/store-apps.service';
import { MarketsContextService } from '../../markets/markets-context.service';
import { MarketPricingService } from '../../markets/market-pricing.service';
import type { MarketContext } from '../../markets/market-context';
import { TaxService } from '../../taxes/tax.service';
import type { PersonalizationService } from '../../personalization/personalization.service';

/**
 * A small in-memory Prisma for the storefront product list. It honours what
 * the list queries use: the where keys the service builds (creator, status,
 * search, collection links, market availability, `AND`, `id.in`),
 * `orderBy` (object or array), `take`, `skip`, `select` and `count`.
 * Without an `orderBy` tie-breaker, rows with equal values keep their
 * fixture order (the database's "physical" order).
 */

export const MARKET: MarketContext = {
  id: 'm-eu',
  key: 'eu',
  name: 'EU',
  countries: ['DE'],
  defaultLocale: 'en',
  locales: [],
  currency: 'EUR',
  storeCurrency: 'SEK',
  rate: 0.1,
  priceRule: {
    mode: 'convert',
    source: 'manual',
    rate: 0.1,
    rounding: { ending: '.99' },
  },
  isDefault: false,
  indexing: 'AUTO',
  status: 'LIVE',
  primaryHostname: null,
  hostnames: [],
};

/** Advanced (personalization app) option config: card style + valueMeta. */
export const CARD_CONFIG = [
  {
    name: 'Antal',
    style: 'card',
    values: ['1', '2'],
    valueMeta: { '2': { label: '2 st', badge: 'Populär', count: 2 } },
  },
];

export interface RowMeta {
  /** Collection (and tag) ids the row is linked to. */
  links?: string[];
  /** Market ids where the row is switched off. */
  hiddenIn?: string[];
  /** Market ids where the row has a product-level price override. */
  overrideIn?: string[];
}

export interface OwnSpec extends RowMeta {
  id: string;
  created: string;
  price?: number;
  title?: string;
  titles?: Record<string, string>;
  optionConfig?: unknown;
  taxExempt?: boolean;
}

export interface CustomSpec extends RowMeta {
  id: string;
  created: string;
  price?: number;
  title?: string;
  titles?: Record<string, string>;
  pricing?: 'SINGLE' | 'PER_VARIANT' | 'MARGIN';
}

export function ownRow(s: OwnSpec) {
  const price = s.price ?? 100;
  const titles = s.titles ?? { sv: s.title ?? `Titel ${s.id}`, en: s.title ?? `Title ${s.id}` };
  return {
    id: s.id,
    provider_id: null,
    creator_id: 'c1',
    category_id: 'cat1',
    product_type: 'TRADITIONAL',
    customization_type: null,
    base_price: price,
    compare_at_price: price + 20,
    cost_price: 12,
    sku: `SKU-${s.id}`,
    track_inventory: true,
    stock_quantity: 4,
    weight: null,
    weight_unit: 'kg',
    variant_option_config: s.optionConfig ?? null,
    shipping_profile_id: null,
    tax_class_id: null,
    tax_exempt: s.taxExempt ?? false,
    status: 'PUBLISHED',
    is_featured: false,
    external_ref: `wc-${s.id}`,
    gtin: '4006381333931',
    mpn: 'M-1',
    brand: null,
    google_product_category: '1604',
    condition: 'new',
    feed_excluded: false,
    primary_creator_category_id: null,
    created_at: new Date(s.created),
    updated_at: new Date(s.created),
    translations: Object.entries(titles).map(([locale, title], i) => ({
      id: `${s.id}-t${i}`,
      product_id: s.id,
      locale,
      title,
      description: `<p>${title}</p>`,
      slug: `${s.id}-${locale}`,
      meta_title: null,
      meta_desc: null,
      short_description: null,
    })),
    images: [
      {
        id: `${s.id}-i`,
        product_id: s.id,
        variant_id: null,
        url: `/uploads/${s.id}.webp`,
        alt_text: null,
        sort_order: 0,
        is_featured: true,
      },
    ],
    variants: [
      {
        id: `${s.id}-v1`,
        product_id: s.id,
        sku: null,
        price_adjustment: 0,
        compare_at_price: null,
        stock_quantity: null,
        is_active: true,
        options: { size: 'S' },
        external_ref: `wc-var-${s.id}`,
      },
      {
        id: `${s.id}-v2`,
        product_id: s.id,
        sku: null,
        price_adjustment: 15,
        compare_at_price: price + 40,
        stock_quantity: 2,
        is_active: true,
        options: { size: 'L' },
        external_ref: null,
      },
    ],
    category: null,
  };
}

export function customRow(s: CustomSpec) {
  const price = s.price ?? 50;
  const titles = s.titles ?? { sv: s.title ?? `Titel ${s.id}`, en: s.title ?? `Title ${s.id}` };
  const pricing = s.pricing ?? 'SINGLE';
  const baseVariant = (n: number, adj: number) => ({
    id: `${s.id}-bv${n}`,
    product_id: `base-${s.id}`,
    sku: null,
    price_adjustment: adj,
    compare_at_price: null,
    stock_quantity: n === 1 ? null : 3,
    is_active: true,
    options: { color: n === 1 ? 'Red' : 'Blue' },
    external_ref: null,
  });
  return {
    id: s.id,
    product_id: `base-${s.id}`,
    creator_id: 'c1',
    import_mode: 'CUSTOMIZE',
    pricing_type: pricing,
    final_price: price,
    margin_amount: pricing === 'MARGIN' ? 7 : null,
    status: 'PUBLISHED',
    rejection_reason: null,
    submitted_at: null,
    reviewed_at: null,
    reviewed_by: null,
    primary_creator_category_id: null,
    created_at: new Date(s.created),
    updated_at: new Date(s.created),
    translations: Object.entries(titles).map(([locale, title], i) => ({
      id: `${s.id}-t${i}`,
      custom_product_id: s.id,
      locale,
      title,
      description: null,
      slug: `${s.id}-${locale}`,
    })),
    mockup_images:
      pricing === 'SINGLE'
        ? [{ id: `${s.id}-m`, custom_product_id: s.id, url: `/uploads/${s.id}-m.webp`, sort_order: 0 }]
        : [],
    selected_variants:
      pricing === 'PER_VARIANT'
        ? [
            {
              id: `${s.id}-sv1`,
              custom_product_id: s.id,
              variant_id: `${s.id}-bv1`,
              custom_price: 61,
              variant: baseVariant(1, 0),
            },
          ]
        : [],
    product: {
      id: `base-${s.id}`,
      base_price: 30,
      tax_class_id: null,
      tax_exempt: false,
      images: [
        {
          id: `${s.id}-bi`,
          product_id: `base-${s.id}`,
          variant_id: null,
          url: `/uploads/base-${s.id}.webp`,
          alt_text: null,
          sort_order: 0,
          is_featured: true,
        },
      ],
      variants: [baseVariant(1, 0), baseVariant(2, 5)],
      category: null,
      provider: { id: 'prov1', company_name: 'Print Co', logo_url: null },
    },
  };
}

type Row = { id: string; created_at: Date } & Record<string, unknown>;
type Where = Record<string, unknown> | undefined;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function matches(row: Row, meta: RowMeta, where: Where): boolean {
  if (!where) return true;
  for (const [key, raw] of Object.entries(where)) {
    const v = raw as Record<string, unknown>;
    switch (key) {
      case 'AND':
        if (!(raw as Where[]).every((w) => matches(row, meta, w))) return false;
        break;
      case 'id':
        if (typeof raw === 'string') {
          if (row.id !== raw) return false;
        } else if (!(v.in as string[]).includes(row.id)) return false;
        break;
      case 'creator_id':
      case 'status':
      case 'category_id':
        if (row[key] !== raw) return false;
        break;
      case 'product': {
        const p = row.product as Record<string, unknown>;
        if (p.category_id !== v.category_id) return false;
        break;
      }
      case 'translations': {
        const contains = (
          (v.some as Record<string, unknown>).title as { contains: string }
        ).contains.toLowerCase();
        const ts = row.translations as { title: string }[];
        if (!ts.some((t) => t.title.toLowerCase().includes(contains)))
          return false;
        break;
      }
      case 'creator_categories': {
        const c = (v.some as Record<string, unknown>).creator_category_id;
        const ids = typeof c === 'string' ? [c] : (c as { in: string[] }).in;
        if (!(meta.links ?? []).some((l) => ids.includes(l))) return false;
        break;
      }
      case 'NOT': {
        const mp = v.market_prices as { some: { market_id: string } };
        if ((meta.hiddenIn ?? []).includes(mp.some.market_id)) return false;
        break;
      }
      case 'market_prices': {
        const some = v.some as { market_id: string };
        if (!(meta.overrideIn ?? []).includes(some.market_id)) return false;
        break;
      }
      default:
        throw new Error(`fake prisma: unsupported where key ${key}`);
    }
  }
  return true;
}

function cmpValues(a: unknown, b: unknown): number {
  const av = a instanceof Date ? a.getTime() : a;
  const bv = b instanceof Date ? b.getTime() : b;
  if (typeof av === 'number' && typeof bv === 'number') return av - bv;
  const as = String(av);
  const bs = String(bv);
  return as < bs ? -1 : as > bs ? 1 : 0;
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const terms = (Array.isArray(orderBy) ? orderBy : [orderBy]) as Record<
    string,
    'asc' | 'desc'
  >[];
  // Array.prototype.sort is stable: equal rows keep the fixture order.
  return [...rows].sort((a, b) => {
    for (const term of terms) {
      const [field, dir] = Object.entries(term)[0];
      const c = cmpValues(a[field], b[field]);
      if (c !== 0) return dir === 'desc' ? -c : c;
    }
    return 0;
  });
}

function deepCopy(v: unknown): unknown {
  if (v instanceof Date) return new Date(v.getTime());
  if (Array.isArray(v)) return v.map(deepCopy);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = deepCopy(x);
    return out;
  }
  return v;
}

function project(row: Row, select: Record<string, unknown>) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(select)) {
    if (v === true) out[k] = row[k];
    else if (v && typeof v === 'object' && 'select' in v) {
      const inner = (v as { select: Record<string, unknown> }).select;
      out[k] = (row[k] as Row[]).map((r) => project(r, inner));
    }
  }
  return out;
}

interface FindArgs {
  where?: Where;
  orderBy?: unknown;
  take?: number;
  skip?: number;
  select?: Record<string, unknown>;
  include?: unknown;
}

function table(rows: Row[], metaOf: Map<string, RowMeta>) {
  const filter = (where: Where) =>
    rows.filter((r) => matches(r, metaOf.get(r.id) ?? {}, where));
  return {
    findMany: jest.fn((args: FindArgs = {}) => {
      let out = sortRows(filter(args.where), args.orderBy);
      if (args.skip) out = out.slice(args.skip);
      if (args.take !== undefined) out = out.slice(0, args.take);
      // Deep copies: the service never sees the fixture objects. (Not
      // structuredClone: under jest it yields objects of another realm,
      // which plain-object checks reject.)
      const copy = out.map((r) => deepCopy(r) as Row);
      return Promise.resolve(
        args.select ? copy.map((r) => project(r, args.select!)) : copy,
      );
    }),
    count: jest.fn((args: { where?: Where } = {}) =>
      Promise.resolve(filter(args.where).length),
    ),
  };
}

export interface ListFixture {
  storeType?: StoreType;
  status?: StoreStatus;
  own: OwnSpec[];
  custom?: CustomSpec[];
  collection?: {
    id: string;
    match_rule: 'MANUAL' | 'TAGS';
    match_tags?: string[];
    is_active?: boolean;
    visibility?: 'PUBLIC' | 'INTERNAL';
    /** MANUAL link order: tokens `p:<id>` / `cp:<id>` → sort_order. */
    order?: Record<string, number>;
  } | null;
  market?: MarketContext | null;
  b2b?: boolean;
  /** Personalization app state; undefined = no runtime service. */
  personalization?: boolean;
  promotions?: {
    id: string;
    type: string;
    value: number;
    product_ids?: string[];
  }[];
}

export function buildList(fx: ListFixture) {
  const store = {
    id: 's1',
    slug: 'shop',
    creator_id: 'c1',
    store_type: fx.storeType ?? StoreType.MARKETPLACE,
    status: fx.status ?? StoreStatus.LIVE,
    show_vendor_name: true,
    currency: 'SEK',
    tax_country: 'SE',
    creator: { id: 'c1' },
  };
  const metaOf = new Map<string, RowMeta>();
  for (const s of [...fx.own, ...(fx.custom ?? [])]) metaOf.set(s.id, s);
  const ownRows = fx.own.map(ownRow) as unknown as Row[];
  const customRows = (fx.custom ?? []).map(customRow) as unknown as Row[];
  const col = fx.collection ?? null;
  const collectionRow = col
    ? {
        id: col.id,
        match_rule: col.match_rule,
        match_tags: col.match_tags ?? [],
        is_active: col.is_active ?? true,
        visibility: col.visibility ?? 'PUBLIC',
      }
    : null;
  const linksOf = (kind: 'p' | 'cp') =>
    Object.entries(col?.order ?? {})
      .filter(([token]) => token.startsWith(`${kind}:`))
      .map(([token, sort_order]) => ({
        id: token.slice(kind.length + 1),
        sort_order,
      }));
  const marketPriceRows = [...fx.own]
    .filter((s) => (s.overrideIn ?? []).length)
    .flatMap((s) =>
      (s.overrideIn ?? []).map((market_id) => ({
        product_id: s.id,
        market_id,
        variant_id: null,
        price: 9.5,
        compare_at_price: null,
        available: true,
      })),
    );
  const prisma = {
    store: { findUnique: jest.fn(() => Promise.resolve(store)) },
    product: table(ownRows, metaOf),
    customProduct: table(customRows, metaOf),
    creatorCategory: {
      findFirst: jest.fn(
        ({ where }: { where: { id?: string; slug?: string } }) =>
          Promise.resolve(
            collectionRow &&
              (where.id === undefined || where.id === collectionRow.id)
              ? collectionRow
              : null,
          ),
      ),
    },
    productCreatorCategory: {
      findMany: jest.fn(() =>
        Promise.resolve(
          linksOf('p').map((l) => ({
            product_id: l.id,
            sort_order: l.sort_order,
          })),
        ),
      ),
    },
    customProductCreatorCategory: {
      findMany: jest.fn(() =>
        Promise.resolve(
          linksOf('cp').map((l) => ({
            custom_product_id: l.id,
            sort_order: l.sort_order,
          })),
        ),
      ),
    },
    promotion: {
      findMany: jest.fn(() =>
        Promise.resolve(
          (fx.promotions ?? []).map((p) => ({
            id: p.id,
            type: p.type,
            value: p.value,
            conditions: p.product_ids ? { product_ids: p.product_ids } : null,
            translations: [{ locale: 'sv', name: `Kampanj ${p.id}` }],
          })),
        ),
      ),
    },
    productMarketPrice: {
      findMany: jest.fn(
        ({ where }: { where: { product_id: { in: string[] } } }) =>
          Promise.resolve(
            marketPriceRows.filter((r) =>
              where.product_id.in.includes(r.product_id),
            ),
          ),
      ),
    },
  };
  const storeApps = {
    isEnabled: jest.fn((_s: string, key: string) =>
      Promise.resolve(key === 'b2b' ? fx.b2b === true : false),
    ),
  };
  const taxService = {
    contextFor: jest.fn(() =>
      Promise.resolve({
        registrant: 'STORE',
        storeId: 's1',
        rateStoreId: 's1',
        taxCountry: 'SE',
        pricingMode: 'INCLUSIVE',
        basis: 'SHIPPING',
        ossRegistered: false,
        usePlatformRates: true,
        shippingTaxClassId: null,
        displayPricesInclTax: true,
      }),
    ),
    loadTaxData: jest.fn(() =>
      Promise.resolve({
        classes: [
          { id: 'std', store_id: null, key: 'standard', name: {}, is_default: true },
        ],
        rates: [
          {
            id: 'r1',
            store_id: null,
            tax_class_id: 'std',
            country: 'SE',
            region: null,
            postcode_pattern: null,
            rate_bp: 2500,
            label: 'VAT',
            priority: 0,
            applies_to_shipping: true,
            is_active: true,
          },
        ],
      }),
    ),
  };
  const markets = {
    resolve: jest.fn(() => Promise.resolve(fx.market ?? null)),
  };
  const personalization =
    fx.personalization === undefined
      ? undefined
      : ({
          isEnabled: jest.fn(() => Promise.resolve(fx.personalization)),
        } as unknown as PersonalizationService);
  const service = new StorefrontService(
    prisma as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
    markets as unknown as MarketsContextService,
    new MarketPricingService(prisma as unknown as PrismaService),
    taxService as unknown as TaxService,
    personalization,
  );
  return { service, prisma, storeApps, taxService };
}

export const ids = (list: unknown) =>
  (list as { id: string }[]).map((p) => p.id);
