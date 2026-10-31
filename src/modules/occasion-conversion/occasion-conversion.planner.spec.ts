import { ImportEntityStatus } from '@prisma/client';
import {
  categoryPath,
  descendantsDeepestFirst,
  planOccasionConversion,
  type ConversionState,
  type StateCategory,
} from './occasion-conversion.planner';

function cat(
  over: Partial<StateCategory> & Pick<StateCategory, 'id' | 'slug'>,
): StateCategory {
  return {
    parent_id: null,
    visibility: 'PUBLIC',
    is_active: true,
    sort_order: 0,
    external_ref: `woo:namez.se:product_cat:${over.id}`,
    thumbnail_url: null,
    translation: {
      name: over.slug,
      description: `<p>${over.slug} short</p>`,
      long_description: null,
      meta_title: null,
      meta_desc: null,
    },
    product_ids: [],
    custom_product_ids: [],
    ...over,
  };
}

/** presenter-till-vem → {pappa, studentpresent → {kille, tjej}}, plus a root `namnskyltar`. */
function state(over: Partial<ConversionState> = {}): ConversionState {
  return {
    storeId: 'store',
    creatorId: 'creator',
    primaryLocale: 'sv',
    categories: [
      cat({ id: 'root', slug: 'presenter-till-vem', product_ids: ['p0'] }),
      cat({
        id: 'pappa',
        slug: 'present-till-pappa',
        parent_id: 'root',
        product_ids: ['p1', 'p2'],
        translation: {
          name: 'Present till pappa',
          description: '<p>Kort text</p>',
          long_description: '<h2>Lång</h2><p>SEO text</p>',
          meta_title: 'Present till pappa – Namez',
          meta_desc: 'Meta desc',
        },
      }),
      cat({
        id: 'student',
        slug: 'studentpresent',
        parent_id: 'root',
        sort_order: 1,
        product_ids: ['p3'],
      }),
      cat({
        id: 'kille',
        slug: 'studentpresent-till-kille',
        parent_id: 'student',
        product_ids: ['p4'],
      }),
      cat({
        id: 'tjej',
        slug: 'studentpresent-till-tjej',
        parent_id: 'student',
        sort_order: 1,
        product_ids: ['p5', 'p4'],
      }),
      cat({ id: 'namn', slug: 'namnskyltar', product_ids: ['p1'] }),
    ],
    products: [
      {
        id: 'p1',
        primary_creator_category_id: 'pappa',
        linked: ['pappa', 'namn'],
      },
      { id: 'p2', primary_creator_category_id: 'pappa', linked: ['pappa'] },
      { id: 'p3', primary_creator_category_id: 'student', linked: ['student'] },
      {
        id: 'p4',
        primary_creator_category_id: 'kille',
        linked: ['kille', 'tjej'],
      },
      {
        id: 'p5',
        primary_creator_category_id: 'namn',
        linked: ['tjej', 'namn'],
      },
    ],
    customProducts: [],
    pages: [
      {
        id: 'about',
        slug: 'about',
        type: 'STATIC',
        status: 'PUBLISHED',
        published_version_id: 'v',
      },
    ],
    staticPageSlugs: ['shipping-policy'],
    redirects: [
      {
        id: 'r1',
        from_path: '/product-category/presenter-till-vem/present-till-pappa',
        to_path: '/collections/presenter-till-vem/present-till-pappa',
        status_code: 301,
        source: 'IMPORT',
        is_active: true,
      },
      {
        id: 'r2',
        from_path: '/product-category/present-till-pappa',
        to_path: '/collections/presenter-till-vem/present-till-pappa',
        status_code: 301,
        source: 'IMPORT',
        is_active: true,
      },
    ],
    menuItems: [
      {
        id: 'm1',
        menu_id: 'h',
        parent_id: null,
        kind: 'COLLECTION',
        resource_id: 'pappa',
        url: '/x',
      },
      {
        id: 'm2',
        menu_id: 'h',
        parent_id: null,
        kind: 'COLLECTION',
        resource_id: 'namn',
        url: '/y',
      },
    ],
    ledger: [],
    ...over,
  };
}

const input = {
  parent_slug: 'presenter-till-vem',
  merge_descendant_products: ['studentpresent'],
};

describe('planOccasionConversion', () => {
  it('orders leaves before parents and builds hierarchical paths', () => {
    const s = state();
    const order = descendantsDeepestFirst('root', s.categories).map(
      (c) => c.slug,
    );
    expect(order).toEqual([
      'present-till-pappa',
      'studentpresent-till-kille',
      'studentpresent-till-tjej',
      'studentpresent',
    ]);
    const byId = new Map(s.categories.map((c) => [c.id, c]));
    expect(categoryPath(byId.get('kille')!, byId)).toEqual([
      'presenter-till-vem',
      'studentpresent',
      'studentpresent-till-kille',
    ]);
  });

  it('plans one published page per sub-collection with the preset sections', () => {
    const p = planOccasionConversion(state(), input);
    expect(p.blockers).toEqual([]);
    expect(p.counts.pages).toEqual({
      CREATE: 4,
      UNCHANGED: 0,
      SKIP: 0,
      CONFLICT: 0,
    });
    const pappa = p.items.find((i) => i.slug === 'present-till-pappa')!;
    expect(pappa.action).toBe('CREATE');
    expect(pappa.page!.title).toBe('Present till pappa');
    expect(pappa.page!.meta_title).toBe('Present till pappa – Namez');
    expect(pappa.page!.meta_description).toBe('Meta desc');
    expect(pappa.page!.sections.map((s) => s.section_key)).toEqual([
      'hero-banner',
      'collection-products',
      'rich-text',
    ]);
    expect(pappa.page!.sections[1].settings.category).toBe('pappa');
    expect(pappa.page!.sections[1].content.heading).toBe('Våra favoriter');
    expect(pappa.page!.sections[2].content.html).toBe(
      '<h2>Lång</h2><p>SEO text</p>',
    );
    expect(pappa.rich_text_source).toBe('long_description');
    expect(pappa.page!.sections[0].content.subheading).toBe('Kort text');
  });

  it('falls back to the short description and a truncated meta description', () => {
    const p = planOccasionConversion(state(), input);
    const kille = p.items.find((i) => i.slug === 'studentpresent-till-kille')!;
    expect(kille.rich_text_source).toBe('description');
    expect(kille.page!.meta_description).toBe(
      'studentpresent-till-kille short',
    );
    expect(kille.page!.sections[0].content.subheading).toBeUndefined();
  });

  it('merges descendant product links only for the listed slugs', () => {
    const p = planOccasionConversion(state(), input);
    const student = p.items.find((i) => i.slug === 'studentpresent')!;
    expect(student.links_added).toEqual([
      { entity: 'PRODUCT', id: 'p4' },
      { entity: 'PRODUCT', id: 'p5' },
    ]);
    expect(student.label_products).toBe(3);
    const tjej = p.items.find((i) => i.slug === 'studentpresent-till-tjej')!;
    expect(tjej.links_added).toEqual([]);
  });

  it('re-picks primaries to the first remaining PUBLIC link and reports the rest', () => {
    const p = planOccasionConversion(state(), input);
    const pappa = p.items.find((i) => i.slug === 'present-till-pappa')!;
    expect(pappa.primaries).toEqual([
      { entity: 'PRODUCT', id: 'p1', from: 'pappa', to: 'namn' },
      { entity: 'PRODUCT', id: 'p2', from: 'pappa', to: null },
    ]);
    // p4 is linked to two converted siblings only → cleared.
    const kille = p.items.find((i) => i.slug === 'studentpresent-till-kille')!;
    expect(kille.primaries).toEqual([
      { entity: 'PRODUCT', id: 'p4', from: 'kille', to: null },
    ]);
    expect(p.counts.primaries).toEqual({ repicked: 1, cleared: 3 });
    expect(
      p.warnings.filter((w) => w.code === 'W_PRODUCT_NO_PUBLIC_COLLECTION'),
    ).toHaveLength(3);
  });

  it('plans one redirect per collection path and repoints the WP rows in one hop', () => {
    const p = planOccasionConversion(state(), input);
    const items = p.redirects.items.map((r) => [
      r.from_path,
      r.to_path,
      r.action,
    ]);
    expect(items).toContainEqual([
      '/collections/presenter-till-vem/present-till-pappa',
      '/present-till-pappa',
      'CREATE',
    ]);
    expect(items).toContainEqual([
      '/collections/presenter-till-vem/studentpresent/studentpresent-till-kille',
      '/studentpresent-till-kille',
      'CREATE',
    ]);
    expect(p.redirects.repoints.map((r) => [r.id, r.to_path])).toEqual([
      ['r1', '/present-till-pappa'],
      ['r2', '/present-till-pappa'],
    ]);
    expect(p.redirects.conflicts).toEqual([]);
  });

  it('switches COLLECTION menu items of converted collections to the page', () => {
    const p = planOccasionConversion(state(), input);
    const pappa = p.items.find((i) => i.slug === 'present-till-pappa')!;
    expect(pappa.menu_items).toEqual([
      { id: 'm1', url: '/present-till-pappa' },
    ]);
    expect(p.counts.menu_items).toBe(1);
  });

  it('CONFLICT on reserved, taken or shadowed slugs and inactive or internal rows', () => {
    const s = state();
    s.categories.push(
      cat({ id: 'c1', slug: 'about', parent_id: 'root' }),
      cat({ id: 'c2', slug: 'products', parent_id: 'root' }),
      cat({ id: 'c3', slug: 'shipping-policy', parent_id: 'root' }),
      cat({ id: 'c4', slug: 'shadowed', parent_id: 'root' }),
      cat({ id: 'c5', slug: 'off', parent_id: 'root', is_active: false }),
      cat({ id: 'c6', slug: 'Bad_Slug', parent_id: 'root' }),
    );
    s.redirects.push({
      id: 'r3',
      from_path: '/shadowed',
      to_path: '/',
      status_code: 301,
      source: 'MANUAL',
      is_active: true,
    });
    const p = planOccasionConversion(s, input);
    const conflicts = Object.fromEntries(
      p.items
        .filter((i) => i.action === 'CONFLICT')
        .map((i) => [i.slug, i.conflicts]),
    );
    expect(conflicts).toEqual({
      about: ['PAGE_SLUG_TAKEN'],
      products: ['PAGE_SLUG_RESERVED'],
      'shipping-policy': ['STATIC_PAGE_SLUG_TAKEN'],
      shadowed: ['REDIRECT_SHADOWS_PAGE'],
      off: ['CATEGORY_INACTIVE'],
      Bad_Slug: ['PAGE_SLUG_INVALID'],
    });
    // Conflicting rows get no redirect and no primary change.
    expect(p.redirects.items.some((r) => r.to_path === '/about')).toBe(false);
    expect(p.counts.pages.CREATE).toBe(4);
  });

  it('WP slugs: Arabic, ä and `_` collections convert; numeric and locale slugs are reserved', () => {
    const s = state();
    s.categories.push(
      cat({ id: 'a1', slug: 'هدية-لأمي', parent_id: 'root' }),
      cat({ id: 'a2', slug: 'kläder', parent_id: 'root' }),
      cat({ id: 'a3', slug: '3d_presenter', parent_id: 'root' }),
      cat({ id: 'a4', slug: '2024', parent_id: 'root' }),
      cat({ id: 'a5', slug: 'sv', parent_id: 'root' }),
    );
    const p = planOccasionConversion(s, input);
    const action = (slug: string) => p.items.find((i) => i.slug === slug);
    expect(action('هدية-لأمي')?.action).toBe('CREATE');
    expect(action('kläder')?.action).toBe('CREATE');
    expect(action('3d_presenter')?.action).toBe('CREATE');
    expect(action('2024')?.conflicts).toEqual(['PAGE_SLUG_RESERVED']);
    expect(action('sv')?.conflicts).toEqual(['PAGE_SLUG_RESERVED']);
  });

  it('the parent slug is matched in its stored form (encoded / upper case input)', () => {
    const s = state();
    s.categories[0] = { ...s.categories[0], slug: 'presenter-till-väm' };
    const p = planOccasionConversion(s, {
      ...input,
      parent_slug: 'PRESENTER-TILL-V%C3%A4M',
    });
    expect(p.blockers).not.toContain('PARENT_NOT_FOUND');
  });

  it('is idempotent: UNCHANGED on re-run, SKIP when the source changed', () => {
    const s = state();
    const first = planOccasionConversion(s, input);
    const pappa = first.items.find((i) => i.slug === 'present-till-pappa')!;
    // After apply: the category is INTERNAL at the root, the page exists,
    // the ledger row is ACTIVE with the same hash.
    const after = state({
      pages: [
        ...s.pages,
        {
          id: 'pg',
          slug: 'present-till-pappa',
          type: 'LANDING',
          status: 'PUBLISHED',
          published_version_id: 'v1',
        },
      ],
      ledger: [
        {
          external_ref: pappa.external_ref,
          target_id: 'pg',
          source_hash: pappa.source_hash,
          applied_hash: 'h',
          status: ImportEntityStatus.ACTIVE,
          last_run_id: 'conv-1',
        },
      ],
    });
    const applied = after.categories.find((c) => c.id === 'pappa')!;
    applied.visibility = 'INTERNAL';
    applied.parent_id = null;
    // The row is an INTERNAL root now, so the tree walk never reaches it:
    // the ledger post-pass lists it as UNCHANGED with no writes.
    const second = planOccasionConversion(after, input);
    const item = second.items.find((i) => i.slug === 'present-till-pappa')!;
    expect(item.action).toBe('UNCHANGED');
    expect(item.page_id).toBe('pg');
    expect(
      second.redirects.items.some((r) => r.to_path === '/present-till-pappa'),
    ).toBe(false);
    expect(second.counts.pages.UNCHANGED).toBe(1);
    expect(second.counts.pages.CREATE).toBe(3);
  });

  it('CONFLICT on a parent whose child is not converted (PLAN == APPLY)', () => {
    const s = state();
    s.categories.find((c) => c.id === 'tjej')!.is_active = false;
    const p = planOccasionConversion(s, input);
    const student = p.items.find((i) => i.slug === 'studentpresent')!;
    expect(student.action).toBe('CONFLICT');
    expect(student.conflicts).toEqual(['CHILD_NOT_CONVERTED']);
    expect(
      p.items.find((i) => i.slug === 'studentpresent-till-kille')!.action,
    ).toBe('CREATE');
    expect(p.counts.pages).toEqual({
      CREATE: 2,
      UNCHANGED: 0,
      SKIP: 0,
      CONFLICT: 2,
    });
  });

  it('CONFLICT when the merchant owns a MANUAL redirect on the collection path', () => {
    const s = state();
    s.redirects.push({
      id: 'r9',
      from_path: '/collections/presenter-till-vem/present-till-pappa',
      to_path: '/somewhere',
      status_code: 301,
      source: 'MANUAL',
      is_active: true,
    });
    const p = planOccasionConversion(s, input);
    const pappa = p.items.find((i) => i.slug === 'present-till-pappa')!;
    expect(pappa.action).toBe('CONFLICT');
    expect(pappa.conflicts).toEqual(['REDIRECT_CONFLICT']);
    expect(p.redirects.conflicts).toEqual([]);
  });

  it('fingerprint changes with the content and the input', () => {
    const a = planOccasionConversion(state(), input).fingerprint;
    const b = planOccasionConversion(state(), {
      parent_slug: 'presenter-till-vem',
    }).fingerprint;
    const s = state();
    s.categories.find((c) => c.id === 'pappa')!.translation!.meta_desc =
      'other';
    const c = planOccasionConversion(s, input).fingerprint;
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(planOccasionConversion(state(), input).fingerprint).toBe(a);
  });

  it('blocks on a missing or internal parent', () => {
    expect(
      planOccasionConversion(state(), { parent_slug: 'nope' }).blockers,
    ).toEqual(['PARENT_NOT_FOUND']);
    const s = state();
    s.categories[0].visibility = 'INTERNAL';
    expect(planOccasionConversion(s, input).blockers).toEqual([
      'PARENT_INTERNAL',
    ]);
    expect(
      planOccasionConversion(state(), { ...input, publish: false }).blockers,
    ).toEqual(['PUBLISH_REQUIRED']);
  });
  it('converts the parent itself after its children with include_parent', () => {
    const p = planOccasionConversion(state(), {
      parent_slug: 'studentpresent',
      include_parent: true,
    });
    expect(p.blockers).toEqual([]);
    expect(
      p.items.filter((i) => i.action === 'CREATE').map((i) => i.slug),
    ).toEqual([
      'studentpresent-till-kille',
      'studentpresent-till-tjej',
      'studentpresent',
    ]);
    const parent = p.items.find((i) => i.slug === 'studentpresent')!;
    expect(parent.redirect_from).toEqual([
      '/collections/presenter-till-vem/studentpresent',
    ]);
    // Without the flag the parent stays a collection.
    const plain = planOccasionConversion(state(), {
      parent_slug: 'studentpresent',
    });
    expect(plain.items.map((i) => i.slug)).not.toContain('studentpresent');
  });
});
