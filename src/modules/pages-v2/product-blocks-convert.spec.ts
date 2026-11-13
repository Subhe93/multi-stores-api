import { HttpException } from '@nestjs/common';
import type { PrismaService } from '../../prisma/prisma.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import {
  CONVERTED_FROM_KEY,
  planClassicProductTree,
  ProductBlocksConvertService,
} from './product-blocks-convert';
import { validateSectionTree } from './section-tree';

// "Convert to blocks" on a product template: hides the monolith, builds the
// Classic tree after it in one transaction, maps settings + per-locale trust
// badges, never publishes, refuses a second conversion.

interface Tr {
  section_id: string;
  locale: string;
  content: Record<string, unknown>;
}
interface Sec {
  id: string;
  page_id: string;
  parent_id: string | null;
  section_key: string;
  settings: Record<string, unknown>;
  sort_order: number;
  is_hidden: boolean;
}
type Where = Record<string, unknown>;

function fakeDb(opts: { pageType?: string; storeId?: string } = {}) {
  let seq = 0;
  const page = {
    id: 'p1',
    store_id: opts.storeId ?? 's1',
    type: opts.pageType ?? 'PRODUCT_TEMPLATE',
    published_version_id: 'v-live',
  };
  const sections: Sec[] = [];
  const translations: Tr[] = [];
  const withTr = (s: Sec) => ({
    ...s,
    translations: translations.filter((t) => t.section_id === s.id),
  });
  const failOnCreateKey = { key: null as string | null };

  const pageSection = {
    findMany: jest.fn(({ where }: { where?: Where } = {}) =>
      Promise.resolve(
        sections
          .filter((s) => !where?.page_id || s.page_id === where.page_id)
          .sort((a, b) => a.sort_order - b.sort_order)
          .map(withTr),
      ),
    ),
    create: jest.fn(
      ({
        data,
      }: {
        data: Omit<Sec, 'id' | 'is_hidden'> & {
          translations?: { create?: { locale: string; content: Record<string, unknown> }[] };
        };
      }) => {
        if (failOnCreateKey.key === data.section_key)
          return Promise.reject(new Error('boom'));
        const s: Sec = {
          id: `sec${++seq}`,
          page_id: data.page_id,
          parent_id: data.parent_id ?? null,
          section_key: data.section_key,
          settings: data.settings ?? {},
          sort_order: data.sort_order ?? 0,
          is_hidden: false,
        };
        sections.push(s);
        for (const t of data.translations?.create ?? [])
          translations.push({ section_id: s.id, locale: t.locale, content: t.content });
        return Promise.resolve({ id: s.id });
      },
    ),
    update: jest.fn(({ where, data }: { where: { id: string }; data: Partial<Sec> }) => {
      const s = sections.find((x) => x.id === where.id);
      if (!s) return Promise.reject(new Error(`no section ${where.id}`));
      Object.assign(s, data);
      return Promise.resolve(withTr(s));
    }),
    // Guarded write: only rows that still match every `where` field change.
    updateMany: jest.fn(
      ({ where, data }: { where: Partial<Sec> & { id: string }; data: Partial<Sec> }) => {
        const hits = sections.filter((x) =>
          (Object.keys(where) as (keyof Sec)[]).every((k) => x[k] === where[k]),
        );
        for (const s of hits) Object.assign(s, data);
        return Promise.resolve({ count: hits.length });
      },
    ),
  };

  const db = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: { findUnique: jest.fn(() => Promise.resolve({ id: 's1' })) },
    page: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === page.id ? { ...page } : null),
      ),
      update: jest.fn(),
    },
    pageVersion: { create: jest.fn() },
    storeLanguageConfig: {
      findFirst: jest.fn(() => Promise.resolve({ primary_locale: 'sv' })),
    },
    pageSection,
    // Snapshot/rollback so a failing step leaves the data untouched, like a
    // real transaction.
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const secCopy = sections.map((s) => ({ ...s }));
      const trCopy = translations.map((t) => ({ ...t }));
      try {
        return await fn(db);
      } catch (e) {
        sections.splice(0, sections.length, ...secCopy);
        translations.splice(0, translations.length, ...trCopy);
        throw e;
      }
    }),
  };

  const seed = (
    s: Partial<Sec> & { id: string; section_key: string },
    trs: { locale: string; content: Record<string, unknown> }[] = [],
  ) => {
    sections.push({
      page_id: 'p1',
      parent_id: null,
      settings: {},
      sort_order: 0,
      is_hidden: false,
      ...s,
    });
    for (const t of trs) translations.push({ section_id: s.id, ...t });
  };

  // The `product_layout` app: on by default; tests flip it to off / unknown.
  const storeApps = {
    enabledOrUnknown: jest.fn(
      (_storeId: string, _key: string): Promise<boolean | null> => Promise.resolve(true),
    ),
  };
  const service = new ProductBlocksConvertService(
    db as unknown as PrismaService,
    storeApps as unknown as StoreAppsService,
  );
  return { db, page, sections, translations, seed, service, failOnCreateKey, storeApps };
}

async function errorOf(p: Promise<unknown>): Promise<{ status: number; code?: string }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof HttpException)
      return {
        status: e.getStatus(),
        code: (e.getResponse() as { code?: string }).code,
      };
    throw e;
  }
  throw new Error('expected an error');
}

const MONOLITH_SETTINGS = {
  show_shipping: true,
  show_tabs: true,
  button_style: 'outline',
  gallery_aspect: 'portrait',
  _style: { padding: { top: 'lg' }, width: 'container', hide_on: ['mobile'] },
};
const TRUST_EN = [{ icon: 'truck', label: 'Fast delivery' }];
const TRUST_AR = [{ icon: 'truck', label: 'توصيل سريع' }];

function seedTemplate(f: ReturnType<typeof fakeDb>, settings: Record<string, unknown> = MONOLITH_SETTINGS) {
  f.seed({ id: 'banner', section_key: 'hero-banner', sort_order: 0 });
  f.seed({ id: 'mono', section_key: 'product-page', sort_order: 1, settings }, [
    { locale: 'en', content: { trust_badges: TRUST_EN } },
    { locale: 'ar', content: { trust_badges: TRUST_AR } },
  ]);
  f.seed({ id: 'faq', section_key: 'faq-list', sort_order: 2 });
}

/** The page as a readable tree: key (children...) in sibling order. */
function shape(rows: { id: string; parent_id: string | null; section_key: string; sort_order: number }[]) {
  const walk = (parent: string | null): string[] =>
    rows
      .filter((r) => r.parent_id === parent)
      .sort((a, b) => a.sort_order - b.sort_order)
      .map((r) => {
        const kids = walk(r.id);
        return kids.length ? `${r.section_key}(${kids.join(',')})` : r.section_key;
      });
  return walk(null);
}

describe('ProductBlocksConvertService.convert', () => {
  it('hides the monolith and builds the Classic tree right after it', async () => {
    const f = fakeDb();
    seedTemplate(f);
    const list = await f.service.convert('u1', 'p1', {});

    expect(f.sections.find((s) => s.id === 'mono')).toMatchObject({ is_hidden: true });
    expect(f.sections.some((s) => s.id === 'mono')).toBe(true);
    expect(shape(f.sections)).toEqual([
      'hero-banner',
      'product-page',
      'layout-row(layout-column(product-gallery),layout-column(product-breadcrumb,product-title,product-price,product-short-description,product-promotions,product-bundles,product-personalization,product-variants,product-personalization,product-buy,product-trust,product-shipping))',
      'product-tabs',
      'faq-list',
    ]);
    // Returned list = the whole page in depth-first tree order.
    expect(list.map((s) => s.section_key)).toEqual([
      'hero-banner',
      'product-page',
      'layout-row',
      'layout-column',
      'product-gallery',
      'layout-column',
      'product-breadcrumb',
      'product-title',
      'product-price',
      'product-short-description',
      'product-promotions',
      'product-bundles',
      'product-personalization',
      'product-variants',
      'product-personalization',
      'product-buy',
      'product-trust',
      'product-shipping',
      'product-tabs',
      'faq-list',
    ]);
    // A valid tree for the product template.
    expect(validateSectionTree(f.sections, 'PRODUCT_TEMPLATE')).toBeNull();
    // Draft only: nothing published.
    expect(f.db.pageVersion.create).not.toHaveBeenCalled();
    expect(f.db.page.update).not.toHaveBeenCalled();
    expect(f.page.published_version_id).toBe('v-live');
  });

  it('maps the monolith settings and per-locale trust badges', async () => {
    const f = fakeDb();
    seedTemplate(f);
    await f.service.convert('u1', 'p1', {});
    const byKey = (k: string) => f.sections.filter((s) => s.section_key === k);
    const trOf = (id: string) =>
      Object.fromEntries(
        f.translations.filter((t) => t.section_id === id).map((t) => [t.locale, t.content]),
      );

    const [row] = byKey('layout-row');
    expect(row.settings).toMatchObject({
      stack_on: 'tablet',
      [CONVERTED_FROM_KEY]: 'mono',
      _style: MONOLITH_SETTINGS._style,
    });
    const [galleryCol, infoCol] = byKey('layout-column').sort((a, b) => a.sort_order - b.sort_order);
    expect(galleryCol.settings).toMatchObject({ sticky_desktop: true, _layout: { span: { desktop: 1 } } });
    expect(infoCol.settings).toMatchObject({ sticky_desktop: false, _layout: { span: { desktop: 1 } } });
    expect(byKey('product-gallery')[0].settings).toMatchObject({ layout: 'classic', aspect: 'portrait' });
    expect(byKey('product-buy')[0].settings).toMatchObject({ button_style: 'outline' });
    // Split around the variants like the monolith: before-variants fields
    // above the picker, the main personalization block below it.
    const personalization = byKey('product-personalization').sort((a, b) => a.sort_order - b.sort_order);
    expect(personalization.map((s) => s.settings.placement)).toEqual(['before_variants', 'after_variants']);
    for (const p of personalization) expect(p.settings).toMatchObject({ button_style: 'outline' });
    const variantsOrder = byKey('product-variants')[0].sort_order;
    expect(personalization[0].sort_order).toBeLessThan(variantsOrder);
    expect(personalization[1].sort_order).toBeGreaterThan(variantsOrder);

    const trust = byKey('product-trust')[0];
    expect(trOf(trust.id)).toEqual({
      en: { trust_badges: TRUST_EN },
      ar: { trust_badges: TRUST_AR },
    });
    // Every new section has a row in each monolith locale.
    for (const s of f.sections.filter((x) => !['banner', 'mono', 'faq'].includes(x.id))) {
      expect(Object.keys(trOf(s.id)).sort()).toEqual(['ar', 'en']);
    }
    // Tabs keep only width / hide-on-device of the monolith style.
    expect(byKey('product-tabs')[0].settings._style).toEqual({
      width: 'container',
      hide_on: ['mobile'],
    });
  });

  it('leaves out shipping and tabs when the monolith hid them', async () => {
    const f = fakeDb();
    seedTemplate(f, { show_shipping: false, show_tabs: false });
    await f.service.convert('u1', 'p1', {});
    const keys = f.sections.map((s) => s.section_key);
    expect(keys).not.toContain('product-shipping');
    expect(keys).not.toContain('product-tabs');
    expect(keys).toContain('product-personalization');
    // Defaults when the monolith carries no style / options.
    const gallery = f.sections.find((s) => s.section_key === 'product-gallery');
    expect(gallery?.settings.aspect).toBe('square');
    const row = f.sections.find((s) => s.section_key === 'layout-row');
    expect(row?.settings._style).toBeUndefined();
  });

  it("uses the store's primary locale when the monolith has no translations", async () => {
    const f = fakeDb();
    f.seed({ id: 'mono', section_key: 'product-page' });
    await f.service.convert('u1', 'p1', {});
    const created = f.sections.filter((s) => s.id !== 'mono');
    for (const s of created) {
      expect(f.translations.filter((t) => t.section_id === s.id).map((t) => t.locale)).toEqual(['sv']);
    }
  });

  it('refuses a second conversion and keeps the page unchanged', async () => {
    const f = fakeDb();
    seedTemplate(f);
    await f.service.convert('u1', 'p1', {});
    const count = f.sections.length;
    expect(await errorOf(f.service.convert('u1', 'p1', {}))).toEqual({
      status: 409,
      code: 'PRODUCT_BLOCKS_ALREADY_CONVERTED',
    });
    // Also when the owner shows the monolith again next to the converted tree.
    f.sections.find((s) => s.id === 'mono')!.is_hidden = false;
    expect(await errorOf(f.service.convert('u1', 'p1', { section_id: 'mono' }))).toEqual({
      status: 409,
      code: 'PRODUCT_BLOCKS_ALREADY_CONVERTED',
    });
    expect(f.sections.length).toBe(count);
  });

  it('refuses an overlapping request that lost the claim on the monolith, without creating', async () => {
    // Two tabs / a retry: both requests read the page before either one
    // committed, so both pass the checks; the second one's guarded hide then
    // matches no row (the first already hid the monolith).
    const f = fakeDb();
    seedTemplate(f);
    f.db.pageSection.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await errorOf(f.service.convert('u1', 'p1', {}))).toEqual({
      status: 409,
      code: 'PRODUCT_BLOCKS_ALREADY_CONVERTED',
    });
    expect(f.db.pageSection.updateMany).toHaveBeenCalledWith({
      where: { id: 'mono', is_hidden: false },
      data: { is_hidden: true },
    });
    expect(f.db.pageSection.create).not.toHaveBeenCalled();
    expect(f.sections.map((s) => s.id)).toEqual(['banner', 'mono', 'faq']);
  });

  it('allows converting again after the converted row was deleted', async () => {
    const f = fakeDb();
    seedTemplate(f, { show_tabs: false });
    await f.service.convert('u1', 'p1', {});
    // Delete the converted tree, show the monolith again.
    const keep = new Set(['banner', 'mono', 'faq']);
    f.sections.splice(0, f.sections.length, ...f.sections.filter((s) => keep.has(s.id)));
    f.sections.find((s) => s.id === 'mono')!.is_hidden = false;
    await f.service.convert('u1', 'p1', {});
    expect(f.sections.filter((s) => s.section_key === 'layout-row')).toHaveLength(1);
  });

  it('refuses when there is no visible product page section', async () => {
    const f = fakeDb();
    f.seed({ id: 'mono', section_key: 'product-page', is_hidden: true });
    expect(await errorOf(f.service.convert('u1', 'p1', {}))).toEqual({
      status: 400,
      code: 'PRODUCT_PAGE_SECTION_NOT_FOUND',
    });
    f.seed({ id: 'x', section_key: 'rich-text', sort_order: 1 });
    expect(await errorOf(f.service.convert('u1', 'p1', { section_id: 'x' }))).toEqual({
      status: 400,
      code: 'PRODUCT_PAGE_SECTION_NOT_FOUND',
    });
  });

  it('refuses a product page nested in a container', async () => {
    const f = fakeDb();
    f.seed({ id: 'row', section_key: 'layout-row' });
    f.seed({ id: 'mono', section_key: 'product-page', parent_id: 'row' });
    expect(await errorOf(f.service.convert('u1', 'p1', {}))).toEqual({
      status: 400,
      code: 'PRODUCT_PAGE_SECTION_NESTED',
    });
  });

  it.each(['add-to-cart', 'product-buy', 'product-variants', 'product-personalization'])(
    'refuses when a visible %s section is already on the page',
    async (key) => {
      const f = fakeDb();
      seedTemplate(f);
      f.seed({ id: 'c', section_key: key, sort_order: 3 });
      expect(await errorOf(f.service.convert('u1', 'p1', {}))).toEqual({
        status: 409,
        code: 'PRODUCT_BLOCKS_CONFLICT',
      });
      // A hidden one does not block the conversion.
      f.sections.find((s) => s.id === 'c')!.is_hidden = true;
      await expect(f.service.convert('u1', 'p1', {})).resolves.toBeDefined();
    },
  );

  it('only works on the product template of the own store', async () => {
    const other = fakeDb({ pageType: 'HOME' });
    seedTemplate(other);
    const e1 = await errorOf(other.service.convert('u1', 'p1', {}));
    expect(e1).toEqual({ status: 400, code: 'PRODUCT_BLOCKS_NOT_PRODUCT_TEMPLATE' });

    const foreign = fakeDb({ storeId: 's2' });
    seedTemplate(foreign);
    expect(await errorOf(foreign.service.convert('u1', 'p1', {}))).toEqual({
      status: 403,
      code: 'PAGE_FORBIDDEN',
    });
    expect(await errorOf(foreign.service.convert('u1', 'nope', {}))).toEqual({
      status: 404,
      code: 'PAGE_NOT_FOUND',
    });
  });

  it.each([
    ['off', false],
    ['unknown', null],
  ])('refuses when the product_layout app is %s, without writing', async (_label, state) => {
    const f = fakeDb();
    seedTemplate(f);
    f.storeApps.enabledOrUnknown.mockResolvedValue(state);
    expect(await errorOf(f.service.convert('u1', 'p1', {}))).toEqual({
      status: 403,
      code: 'PRODUCT_LAYOUT_DISABLED',
    });
    expect(f.storeApps.enabledOrUnknown).toHaveBeenCalledWith('s1', 'product_layout');
    expect(f.db.$transaction).not.toHaveBeenCalled();
    expect(f.db.pageSection.create).not.toHaveBeenCalled();
    expect(f.db.pageSection.update).not.toHaveBeenCalled();
    expect(f.db.pageSection.updateMany).not.toHaveBeenCalled();
    expect(f.sections.map((s) => s.id)).toEqual(['banner', 'mono', 'faq']);
    expect(f.sections.find((s) => s.id === 'mono')?.is_hidden).toBe(false);
  });

  it('fails closed when no StoreAppsService is injected', async () => {
    const f = fakeDb();
    seedTemplate(f);
    const bare = new ProductBlocksConvertService(f.db as unknown as PrismaService);
    expect(await errorOf(bare.convert('u1', 'p1', {}))).toEqual({
      status: 403,
      code: 'PRODUCT_LAYOUT_DISABLED',
    });
    expect(f.db.pageSection.create).not.toHaveBeenCalled();
  });

  it('rolls everything back when a step fails', async () => {
    const f = fakeDb();
    seedTemplate(f);
    f.failOnCreateKey.key = 'product-buy';
    await expect(f.service.convert('u1', 'p1', {})).rejects.toThrow('boom');
    expect(f.sections.map((s) => s.id)).toEqual(['banner', 'mono', 'faq']);
    expect(f.sections.find((s) => s.id === 'mono')?.is_hidden).toBe(false);
  });
});

describe('planClassicProductTree', () => {
  it('always pairs personalization with variants and buy, never the add-to-cart composite', () => {
    const plan = planClassicProductTree({ id: 'm', settings: {}, translations: [] }, ['en']);
    const keys = plan.map((p) => p.section_key);
    expect(keys).toEqual(expect.arrayContaining(['product-variants', 'product-personalization', 'product-buy']));
    expect(keys).not.toContain('add-to-cart');
    expect(keys).not.toContain('product-page');
    // Parents come before their children.
    const seen = new Set<string>();
    for (const p of plan) {
      if (p.parentRef) expect(seen.has(p.parentRef)).toBe(true);
      seen.add(p.ref);
    }
  });

  it('ignores invalid option values', () => {
    const plan = planClassicProductTree(
      { id: 'm', settings: { button_style: 'neon', gallery_aspect: 'wide' }, translations: [] },
      ['en'],
    );
    expect(plan.find((p) => p.section_key === 'product-buy')?.settings.button_style).toBe('solid');
    expect(plan.find((p) => p.section_key === 'product-gallery')?.settings.aspect).toBe('square');
  });
});
