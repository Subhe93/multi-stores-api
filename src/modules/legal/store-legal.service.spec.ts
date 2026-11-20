import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { Prisma, StoreStatus, StoreType } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { MarketContext } from '../markets/market-context';
import {
  StoreLegalService,
  formatTraderAddress,
  localizedStoreName,
  marketPublicHost,
} from './store-legal.service';

const TRADER = {
  legal_name: 'Anna <Shop> AB',
  org_number: '556016-0680',
  address_line1: 'Gatan 1',
  postal_code: '111 22',
  city: 'Stockholm',
  country: 'SE',
  phone: '+46701234567',
  support_email: 'help@anna.se',
};

interface Fixture {
  storeType?: StoreType;
  status?: StoreStatus;
  v2?: Array<Record<string, unknown>>;
  legacy?: Array<Record<string, unknown>>;
  existingV2?: { id: string } | null;
  secondary?: string[];
  trader?: Record<string, unknown> | null;
  /** PlatformConfig.support_email (undefined → no config row). */
  platformEmail?: string | null;
  /** Store.theme_config (localized store names under `translations`). */
  themeConfig?: unknown;
  /** MarketsContextService.resolve stand-in (absent → no markets service). */
  resolveMarket?: (
    storeId: string,
    key?: string | null,
    opts?: { preview?: boolean },
  ) => Promise<MarketContext | null>;
  /** Published snapshot meta per version id (default: 1 section, live titles). */
  versionMeta?: Record<
    string,
    { section_count: number; titles: { locale: string; title: string }[] }
  >;
}

function build(f: Fixture = {}) {
  const store = {
    id: 's1',
    slug: 'anna',
    name: 'Anna',
    status: f.status ?? StoreStatus.LIVE,
    store_type: f.storeType ?? StoreType.INDEPENDENT,
    trader_details: f.trader === undefined ? TRADER : f.trader,
    custom_domain: 'anna.se',
    ...(f.themeConfig === undefined ? {} : { theme_config: f.themeConfig }),
    language_config: {
      primary_locale: 'sv',
      secondary_locales: f.secondary ?? [],
    },
  };
  const created: Record<string, unknown>[] = [];
  const sections: Record<string, unknown>[] = [];
  const tx = {
    page: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return Promise.resolve({ id: 'new-page' });
      }),
      findFirst: jest.fn((_args: { where: { slug?: string } }) =>
        Promise.resolve(null as { id: string } | null),
      ),
    },
    staticPage: { findFirst: jest.fn(() => Promise.resolve(null)) },
    pageSection: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        sections.push(data);
        return Promise.resolve({ id: 'sec' });
      }),
    },
  };
  const prisma = {
    store: {
      findUnique: jest.fn(() => Promise.resolve(store)),
      findFirst: jest.fn(() => Promise.resolve(store)),
    },
    page: {
      findMany: jest.fn(() => Promise.resolve(f.v2 ?? [])),
      findFirst: jest.fn(() => Promise.resolve(f.existingV2 ?? null)),
    },
    staticPage: { findMany: jest.fn(() => Promise.resolve(f.legacy ?? [])) },
    storeDomain: { findMany: jest.fn(() => Promise.resolve([])) },
    platformConfig: {
      findFirst: jest.fn(() =>
        Promise.resolve(
          f.platformEmail === undefined
            ? null
            : { support_email: f.platformEmail },
        ),
      ),
    },
    // The snapshot JSON path query of loadStoreLegalRows.
    $queryRaw: jest.fn(() =>
      Promise.resolve(
        (f.v2 ?? []).flatMap((p) => {
          const id = p.published_version_id as string | null;
          if (!id) return [];
          return [
            {
              id,
              ...(f.versionMeta?.[id] ?? {
                section_count: 1,
                titles: p.translations,
              }),
            },
          ];
        }),
      ),
    ),
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const revalidation = {
    revalidateStoreById: jest.fn(() => Promise.resolve()),
  };
  const config = { get: () => 'https://shopsdoor.com' };
  const service = new StoreLegalService(
    prisma as unknown as PrismaService,
    revalidation as unknown as RevalidationService,
    config as unknown as ConfigService,
    undefined,
    f.resolveMarket
      ? ({
          resolve: jest.fn(f.resolveMarket),
        } as unknown as MarketsContextService)
      : undefined,
  );
  return { service, prisma, revalidation, created, sections, tx };
}

const publishedV2 = {
  id: 'p1',
  slug: 'privacy-policy',
  static_kind: 'PRIVACY_POLICY',
  published_version_id: 'v1',
  updated_at: new Date('2026-11-01T00:00:00Z'),
  translations: [
    { locale: 'sv', title: 'Integritetspolicy' },
    { locale: 'en', title: 'Privacy' },
  ],
  published_version: { published_at: new Date('2026-11-02T00:00:00Z') },
};

const draftOf = (row: typeof publishedV2) => ({
  ...row,
  published_version_id: null,
  published_version: null,
});

const publishedLegacy = {
  id: 'l1',
  slug: 'villkor',
  type: 'TERMS',
  status: 'PUBLISHED',
  updated_at: new Date('2026-10-01T00:00:00Z'),
  translations: [{ locale: 'sv', title: 'Villkor', content: '<p>Text</p>' }],
};

describe('StoreLegalService.storefrontPage', () => {
  it('INDEPENDENT with a published v2 page → store_page (v2)', async () => {
    const { service } = build({ v2: [publishedV2], legacy: [publishedLegacy] });
    await expect(
      service.storefrontPage('anna', 'privacy', { locale: 'en' }),
    ).resolves.toEqual({
      source: 'store_page',
      title: 'Privacy',
      page_slug: 'privacy-policy',
      page_system: 'v2',
      updated_at: new Date('2026-11-02T00:00:00Z'),
    });
  });

  it('INDEPENDENT with a published legacy page → store_page (legacy)', async () => {
    const { service } = build({ legacy: [publishedLegacy] });
    await expect(
      service.storefrontPage('anna', 'terms'),
    ).resolves.toMatchObject({
      source: 'store_page',
      title: 'Villkor',
      page_slug: 'villkor',
      page_system: 'legacy',
    });
  });

  it('INDEPENDENT without an own page → filled, sanitized template', async () => {
    const { service } = build({ v2: [draftOf(publishedV2)] });
    const res = await service.storefrontPage('anna', 'privacy', {
      locale: 'en',
    });
    expect(res.source).toBe('template');
    expect(res.updated_at).toBeNull();
    expect((res as { locale: string }).locale).toBe('en');
    const content = (res as { content: string }).content;
    expect(content).not.toMatch(/\{\{/);
    expect(content).not.toContain('<Shop>');
    expect(content).not.toMatch(/<script/i);
  });

  it('template locale is the one actually used (fallback → en)', async () => {
    const { service } = build();
    const pt = await service.storefrontPage('anna', 'terms', {
      locale: 'pt-BR',
    });
    expect(pt).toMatchObject({ source: 'template', locale: 'en' });
    const ar = await service.storefrontPage('anna', 'terms', {
      locale: 'AR',
    });
    expect(ar).toMatchObject({ source: 'template', locale: 'ar' });
  });

  it('published v2: title from the published snapshot, not the live draft', async () => {
    const { service } = build({
      v2: [
        {
          ...publishedV2,
          translations: [{ locale: 'en', title: 'Unpublished draft title' }],
        },
      ],
      versionMeta: {
        v1: {
          section_count: 1,
          titles: [{ locale: 'en', title: 'Published privacy' }],
        },
      },
    });
    await expect(
      service.storefrontPage('anna', 'privacy', { locale: 'en' }),
    ).resolves.toMatchObject({ title: 'Published privacy' });
    const rows = await service.storefrontList('anna', { locale: 'en' });
    expect(rows[0].title).toBe('Published privacy');
  });

  it('?locale= is matched case-insensitively (pt-BR / EN)', async () => {
    const { service } = build({
      v2: [
        {
          ...publishedV2,
          translations: [
            { locale: 'sv', title: 'Integritetspolicy' },
            { locale: 'pt-BR', title: 'Privacidade' },
            { locale: 'en', title: 'Privacy' },
          ],
        },
      ],
    });
    await expect(
      service.storefrontPage('anna', 'privacy', { locale: 'pt-br' }),
    ).resolves.toMatchObject({ title: 'Privacidade' });
    await expect(
      service.storefrontPage('anna', 'privacy', { locale: 'EN' }),
    ).resolves.toMatchObject({ title: 'Privacy' });
  });

  it('published v2 with an empty snapshot → template', async () => {
    const { service } = build({
      v2: [publishedV2],
      versionMeta: { v1: { section_count: 0, titles: [] } },
    });
    await expect(
      service.storefrontPage('anna', 'privacy', { locale: 'en' }),
    ).resolves.toMatchObject({ source: 'template' });
  });

  it('empty legal name / org number / address never leave broken text', async () => {
    const { service } = build({
      trader: { support_email: 'help@anna.se' },
    });
    for (const slug of ['privacy', 'terms', 'refund', 'shipping']) {
      for (const locale of ['sv', 'en', 'de', 'fr', 'ar', 'tr']) {
        const res = await service.storefrontPage('anna', slug, { locale });
        const html = (res as { content: string }).content;
        const text = html.replace(/<[^>]*>/g, ' ');
        // The seller is the store name when no legal name is set.
        if (slug === 'terms') expect(text).toContain('Anna');
        expect(html).not.toMatch(/<p>\s*<\/p>/);
        // No dangling separators such as "drivs av , org.nr ." / "Adress: ".
        expect(text).not.toMatch(/[,،]\s*[,.،]/);
        expect(text).not.toMatch(
          /(org\.nr|reg\. no\.|Org\.-Nr\.|sicil no\.)\s*[,.;]/,
        );
        expect(text).not.toMatch(
          /(Adress|Address|Adresse|Adres|العنوان)\s*:\s*$/m,
        );
      }
    }
  });

  it('MARKETPLACE → template with Namez AB as the seller (own pages ignored)', async () => {
    const { service, prisma } = build({
      storeType: StoreType.MARKETPLACE,
      v2: [publishedV2],
      platformEmail: 'support@shopsdoor.com',
    });
    const res = await service.storefrontPage('anna', 'privacy', {
      locale: 'en',
    });
    expect(res).toMatchObject({
      source: 'template',
      title: 'Privacy Policy',
      locale: 'en',
      updated_at: null,
    });
    const html = (res as { content: string }).content;
    expect(html).toContain(
      'Namez AB, company reg. no. 559295-1007, Hagavägen 36, 784 40 Borlänge, Sweden, is the controller',
    );
    expect(html).toContain('mailto:support@shopsdoor.com');
    expect(html).toContain('which is the seller and the controller');
    expect(html).not.toContain('processes personal data on our behalf');
    // The influencer's trader details and own pages are not used.
    expect(html).not.toContain('Anna &lt;Shop&gt; AB');
    expect(html).not.toContain('help@anna.se');
    expect(html).toContain('Anna (https://anna.se)');
    expect(prisma.page.findMany).not.toHaveBeenCalled();
  });

  it('MARKETPLACE: localized platform address, contact email fallback', async () => {
    const { service } = build({ storeType: StoreType.MARKETPLACE });
    const sv = await service.storefrontPage('anna', 'privacy', {
      locale: 'sv',
    });
    const html = (sv as { content: string }).content;
    expect(html).toContain('Hagavägen 36, 784 40 Borlänge, Sverige');
    expect(html).toContain('mailto:hello@shopsdoor.com');
    expect(html).not.toContain('personuppgiftsbiträdesavtal');
    for (const slug of ['privacy', 'terms', 'refund', 'shipping']) {
      for (const locale of ['sv', 'en', 'de', 'fr', 'ar', 'tr']) {
        const res = await service.storefrontPage('anna', slug, { locale });
        const out = (res as { content: string }).content;
        expect(out).not.toMatch(/\{\{|data-if/);
        if (slug !== 'shipping') expect(out).toContain('Namez AB');
        expect(out).not.toMatch(/<(p|li)>\s*<\/\1>/);
      }
    }
  });

  it('unknown slug → 404; closed store → 404', async () => {
    const { service } = build();
    await expect(
      service.storefrontPage('anna', 'cookies'),
    ).rejects.toBeInstanceOf(NotFoundException);
    const closed = build({ status: StoreStatus.DRAFT });
    await expect(
      closed.service.storefrontPage('anna', 'privacy'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('StoreLegalService.storefrontList', () => {
  it('INDEPENDENT: 4 rows in fixed order with source + page_slug', async () => {
    const { service } = build({ v2: [publishedV2], legacy: [publishedLegacy] });
    const rows = await service.storefrontList('anna', { locale: 'sv' });
    expect(rows.map((r) => [r.slug, r.source, r.page_slug])).toEqual([
      ['privacy', 'store_page', 'privacy-policy'],
      ['terms', 'store_page', 'villkor'],
      ['refund', 'template', null],
      ['shipping', 'template', null],
    ]);
    expect(rows[0].title).toBe('Integritetspolicy');
    expect(rows[2].title).toBeTruthy();
  });

  it('MARKETPLACE: template titles, own pages ignored', async () => {
    const { service } = build({
      storeType: StoreType.MARKETPLACE,
      v2: [publishedV2],
    });
    const rows = await service.storefrontList('anna');
    expect(rows.map((r) => r.source)).toEqual([
      'template',
      'template',
      'template',
      'template',
    ]);
    expect(rows[0]).toEqual({
      slug: 'privacy',
      title: 'Integritetspolicy',
      source: 'template',
      page_slug: null,
    });
  });
});

describe('StoreLegalService.creatorList', () => {
  it('states, page ids and template use', async () => {
    const { service } = build({
      v2: [
        publishedV2,
        {
          ...draftOf(publishedV2),
          id: 'p3',
          slug: 'return-policy',
          static_kind: 'RETURN_POLICY',
        },
      ],
    });
    const res = await service.creatorList('u1');
    expect(res.store_type).toBe('INDEPENDENT');
    expect(res.pages[0]).toEqual({
      slug: 'privacy',
      kind: 'PRIVACY_POLICY',
      title: 'Integritetspolicy',
      state: 'published',
      page_id: 'p1',
      page_system: 'v2',
      uses_template: false,
      storefront_path: '/legal/privacy',
    });
    expect(res.pages[1]).toMatchObject({
      state: 'none',
      page_id: null,
      page_system: null,
      uses_template: true,
    });
    expect(res.pages[2]).toMatchObject({
      state: 'draft',
      page_id: 'p3',
      page_system: 'v2',
      uses_template: true,
    });
  });
});

describe('StoreLegalService.createFromTemplate', () => {
  it('creates a DRAFT v2 STATIC page with one rich-text section', async () => {
    const { service, created, sections, revalidation } = build({
      secondary: ['en'],
    });
    await expect(service.createFromTemplate('u1', 'refund')).resolves.toEqual({
      page_id: 'new-page',
    });
    expect(created[0]).toMatchObject({
      store_id: 's1',
      type: 'STATIC',
      static_kind: 'RETURN_POLICY',
      slug: 'return-policy',
      status: 'DRAFT',
    });
    const titles = (created[0].translations as { create: { locale: string }[] })
      .create;
    // sv (primary: its own template, else English) + en.
    expect(titles.map((t) => t.locale)).toEqual(['sv', 'en']);
    expect(sections[0]).toMatchObject({
      section_key: 'rich-text',
      sort_order: 0,
    });
    const content = (
      sections[0].translations as { create: { content: { html: string } }[] }
    ).create;
    expect(content).toHaveLength(2);
    expect(content[0].content.html).not.toMatch(/\{\{/);
    expect(revalidation.revalidateStoreById).toHaveBeenCalledWith('s1');
  });

  it('suffixes the slug when another page has it', async () => {
    const { service, created, tx } = build();
    tx.page.findFirst.mockImplementation((args) =>
      Promise.resolve(args.where.slug === 'terms' ? { id: 'other' } : null),
    );
    await service.createFromTemplate('u1', 'terms');
    expect(created[0].slug).toBe('terms-2');
  });

  it('409 LEGAL_PAGE_EXISTS when a v2 page of the kind exists', async () => {
    const { service, prisma } = build({ existingV2: { id: 'p1' } });
    const err = await service
      .createFromTemplate('u1', 'privacy')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'LEGAL_PAGE_EXISTS',
      page_id: 'p1',
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('409 LEGAL_PAGE_EXISTS when a concurrent create wins the race (P2002)', async () => {
    const { service, prisma, revalidation } = build();
    const p2002 = new Prisma.PrismaClientKnownRequestError('Unique', {
      code: 'P2002',
      clientVersion: 'test',
    });
    prisma.$transaction.mockRejectedValue(p2002);
    // No page of the kind before the create; the winner's page after.
    prisma.page.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'winner' });
    const err = await service
      .createFromTemplate('u1', 'privacy')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: 'LEGAL_PAGE_EXISTS',
      page_id: 'winner',
    });
    expect(revalidation.revalidateStoreById).not.toHaveBeenCalled();
  });

  it('400 LEGAL_PAGES_PLATFORM for MARKETPLACE stores', async () => {
    const { service } = build({ storeType: StoreType.MARKETPLACE });
    const err = await service
      .createFromTemplate('u1', 'privacy')
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: 'LEGAL_PAGES_PLATFORM',
    });
  });

  it('unknown slug → 404', async () => {
    const { service } = build();
    await expect(
      service.createFromTemplate('u1', 'cookies'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

function marketCtx(over: Partial<MarketContext> = {}): MarketContext {
  return {
    id: 'm-default',
    key: 'se',
    name: 'Sweden',
    countries: ['SE'],
    defaultLocale: 'sv',
    locales: [],
    currency: 'SEK',
    storeCurrency: 'SEK',
    rate: 1,
    priceRule: { mode: 'auto' } as unknown as MarketContext['priceRule'],
    isDefault: true,
    status: 'LIVE',
    indexing: 'AUTO' as MarketContext['indexing'],
    primaryHostname: 'anna.se',
    hostnames: ['anna.se'],
    ...over,
  };
}

const EU = marketCtx({
  id: 'm-eu',
  key: 'eu',
  name: 'EU',
  defaultLocale: 'en',
  locales: ['de', 'fr', 'ar'],
  currency: 'EUR',
  rate: 0.09,
  isDefault: false,
  primaryHostname: 'anna.shop',
  hostnames: ['anna.shop', 'www.anna.shop'],
});

/** resolve() stand-in: default market without a key, EU for `eu`. */
const twoMarkets = (storeId: string, key?: string | null) =>
  Promise.resolve(key === 'eu' ? EU : marketCtx());

const SV_NAME = 'Anna – Personliga presenter';
const THEME = {
  translations: {
    sv: { name: SV_NAME },
    de: { name: 'Anna – Personalisierte Geschenke' },
    en: { name: 'Anna – Personalised gifts' },
  },
};

const contentOf = (res: unknown) => (res as { content: string }).content;

describe('StoreLegalService: market URL + localized store name', () => {
  it('secondary market: the URL of the market served, the name in the page locale', async () => {
    const { service } = build({
      themeConfig: THEME,
      resolveMarket: twoMarkets,
    });
    const de = contentOf(
      await service.storefrontPage('anna', 'terms', {
        locale: 'de',
        market: 'eu',
      }),
    );
    expect(de).toContain(
      'bei Anna – Personalisierte Geschenke (https://anna.shop) kaufen',
    );
    expect(de).not.toContain('https://anna.se');
    expect(de).not.toContain(SV_NAME);
    // The seller line is unchanged: trader.legal_name stays the legal name.
    expect(de).toContain('wird betrieben von Anna &lt;Shop&gt; AB');
  });

  it('default market on the same store: unchanged URL, own-locale name', async () => {
    const { service } = build({
      themeConfig: THEME,
      resolveMarket: twoMarkets,
    });
    const sv = contentOf(
      await service.storefrontPage('anna', 'terms', { locale: 'sv' }),
    );
    expect(sv).toContain(`${SV_NAME} (https://anna.se)`);
  });

  it('a locale without a translation falls back to Store.name', async () => {
    const { service } = build({
      themeConfig: THEME,
      resolveMarket: twoMarkets,
    });
    const fr = contentOf(
      await service.storefrontPage('anna', 'terms', {
        locale: 'fr',
        market: 'eu',
      }),
    );
    expect(fr).toContain('Anna (https://anna.shop)');
  });

  it('preview of a market without an ACTIVE host: the store URL as before', async () => {
    const draft = marketCtx({
      ...EU,
      status: 'DRAFT',
      preview: true,
      primaryHostname: 'anna.shop',
      hostnames: [],
    });
    const { service } = build({
      resolveMarket: (_s, key, opts) =>
        Promise.resolve(key === 'eu' && opts?.preview ? draft : marketCtx()),
    });
    const en = contentOf(
      await service.storefrontPage('anna', 'terms', {
        locale: 'en',
        market: 'eu',
        preview: true,
      }),
    );
    expect(en).toContain('Anna (https://anna.se)');
  });

  it('preview of a market with an ACTIVE host: that host', async () => {
    const { service } = build({
      resolveMarket: (_s, key) =>
        Promise.resolve(key === 'eu' ? { ...EU, preview: true } : marketCtx()),
    });
    const en = contentOf(
      await service.storefrontPage('anna', 'terms', {
        locale: 'en',
        market: 'eu',
        preview: true,
      }),
    );
    expect(en).toContain('Anna (https://anna.shop)');
  });

  it('MARKETPLACE: market URL and localized name too, Namez AB stays the seller', async () => {
    const { service } = build({
      storeType: StoreType.MARKETPLACE,
      themeConfig: THEME,
      resolveMarket: twoMarkets,
    });
    const de = contentOf(
      await service.storefrontPage('anna', 'terms', {
        locale: 'de',
        market: 'eu',
      }),
    );
    expect(de).toContain(
      'Anna – Personalisierte Geschenke (https://anna.shop)',
    );
    expect(de).toContain('Namez AB');
  });

  it('one market / no markets app / no translation: byte-identical output', async () => {
    // Baseline: the pre-change wiring (no markets service, no theme_config).
    const base = build();
    const variants = [
      build({ resolveMarket: () => Promise.resolve(null) }), // app off
      build({ resolveMarket: () => Promise.resolve(marketCtx()) }), // one market
      build({
        resolveMarket: () => Promise.resolve(marketCtx()),
        themeConfig: { translations: { tr: { name: 'Anna TR' } } },
      }),
      build({ themeConfig: { translations: { sv: { name: '  ' } } } }),
      build({ themeConfig: 'not-an-object' }),
    ];
    for (const storeType of [StoreType.INDEPENDENT, StoreType.MARKETPLACE]) {
      const baseline = build({ storeType });
      const typed = [
        build({ storeType, resolveMarket: () => Promise.resolve(null) }),
        build({
          storeType,
          resolveMarket: () => Promise.resolve(marketCtx()),
        }),
      ];
      for (const slug of ['privacy', 'terms', 'refund', 'shipping']) {
        for (const locale of ['sv', 'en', 'de', 'fr', 'ar']) {
          const want = await baseline.service.storefrontPage('anna', slug, {
            locale,
          });
          for (const v of typed) {
            await expect(
              v.service.storefrontPage('anna', slug, { locale }),
            ).resolves.toEqual(want);
          }
        }
      }
    }
    for (const slug of ['privacy', 'terms', 'refund', 'shipping']) {
      for (const locale of ['sv', 'en', 'de', 'fr', 'ar']) {
        const want = await base.service.storefrontPage('anna', slug, {
          locale,
        });
        if (slug !== 'shipping' && slug !== 'refund') {
          expect(contentOf(want)).toContain('Anna');
          expect(contentOf(want)).toContain('https://anna.se');
        }
        for (const v of variants) {
          await expect(
            v.service.storefrontPage('anna', slug, { locale }),
          ).resolves.toEqual(want);
        }
      }
    }
  });

  it('createFromTemplate: per-locale name, the store URL', async () => {
    const { service, sections } = build({
      themeConfig: THEME,
      secondary: ['de'],
      resolveMarket: twoMarkets,
    });
    await service.createFromTemplate('u1', 'terms');
    const html = JSON.stringify(sections[0]);
    expect(html).toContain(`${SV_NAME} (https://anna.se)`);
    expect(html).toContain(
      'Anna – Personalisierte Geschenke (https://anna.se)',
    );
  });
});

describe('localizedStoreName / marketPublicHost', () => {
  it('matches the locale exactly, case-insensitively, then by base language', () => {
    const store = {
      name: ' Anna ',
      theme_config: {
        translations: { 'pt-BR': { name: 'Anna BR' }, de: { name: 'Anna DE' } },
      },
    };
    expect(localizedStoreName(store, 'pt-BR')).toBe('Anna BR');
    expect(localizedStoreName(store, 'PT-br')).toBe('Anna BR');
    expect(localizedStoreName(store, 'de-AT')).toBe('Anna DE');
    expect(localizedStoreName(store, 'sv')).toBe('Anna');
    expect(localizedStoreName({ name: 'Anna' }, 'de')).toBe('Anna');
  });

  it('only a non-default market with an ACTIVE primary host', () => {
    expect(marketPublicHost(null)).toBeNull();
    expect(marketPublicHost(marketCtx())).toBeNull();
    expect(marketPublicHost(EU)).toBe('anna.shop');
    expect(marketPublicHost({ ...EU, hostnames: [] })).toBeNull();
    expect(marketPublicHost({ ...EU, primaryHostname: null })).toBeNull();
  });
});

describe('formatTraderAddress', () => {
  it('one line with the country name', () => {
    expect(formatTraderAddress(TRADER, 'en')).toBe(
      'Gatan 1, 111 22 Stockholm, Sweden',
    );
    expect(formatTraderAddress(TRADER, 'sv')).toBe(
      'Gatan 1, 111 22 Stockholm, Sverige',
    );
  });
});
