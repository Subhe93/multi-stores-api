import {
  buildPlan,
  fingerprint,
  parseArgs,
  renderPlan,
  type SnapEntity,
  type Snapshot,
} from './legacy-slugs-fix.planner';

// Legacy slug repair ops script (plans/slug-wp-rules): real sanitizeTitle
// from @multi-stores/core, no database.

const STORE = { id: 'store-1', slug: 'namez', primary_locale: 'sv' };

let seq = 0;
function entity(
  over: Partial<SnapEntity> & { slug: string; title: string },
): SnapEntity {
  const id = over.id ?? `0000000${++seq}-aaaa-bbbb-cccc-dddddddddddd`;
  const { slug, title, ...rest } = over;
  return {
    kind: 'product',
    id,
    creator_id: 'cr-1',
    provider_id: null,
    store: STORE,
    status: 'PUBLISHED',
    created_at: '2026-01-01T00:00:00.000Z',
    translations: [{ id: `tr-${id}`, locale: 'sv', title, slug }],
    ...rest,
  };
}

const snap = (
  entities: SnapEntity[],
  categories: Snapshot['categories'] = [],
): Snapshot => ({
  entities,
  categories,
});

describe('legacy-slugs-fix planner', () => {
  it('repairs a dashes-only slug from the Arabic title', async () => {
    const plan = await buildPlan(
      snap([
        entity({
          slug: '---',
          title: 'هدية لأمي',
          store: { ...STORE, primary_locale: 'ar' },
        }),
      ]),
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].new_slug).toBe('هدية-لأمي');
    expect(plan.changes[0].reasons).toEqual(['blank']);
  });

  it('falls back to the EN title, then product-<id8>', async () => {
    const a = entity({ slug: '--', title: '!!!' });
    a.translations.push({
      id: 'tr-en',
      locale: 'en',
      title: 'Gift box',
      slug: 'gift-box',
    });
    const b = entity({
      id: 'abcdef12-3456-7890-abcd-ef1234567890',
      slug: '-',
      title: '',
    });
    const plan = await buildPlan(snap([a, b]));
    const bySlug = Object.fromEntries(
      plan.changes.map((c) => [c.id, c.new_slug]),
    );
    // `gift-box` is the product's own EN slug: same entity, no suffix.
    expect(bySlug[a.id]).toBe('gift-box');
    expect(bySlug[b.id]).toBe('product-abcdef12');
  });

  it('collapses a triple dash using the title', async () => {
    const plan = await buildPlan(
      snap([
        entity({
          slug: 'natural-cotton-v-classic-t-shirt---vit',
          title: 'Natural Cotton V Classic T-shirt – Vit',
        }),
      ]),
    );
    expect(plan.changes[0].new_slug).toBe(
      'natural-cotton-v-classic-t-shirt-vit',
    );
    expect(plan.changes[0].reasons).toEqual(['dashes']);
  });

  it('repairs letters an old slugify dropped (frn -> fran)', async () => {
    const plan = await buildPlan(
      snap([
        entity({
          slug: 'dalahst-i-silver--en-exklusiv-present-frn-sverige',
          title: 'Dalahäst i silver – en exklusiv present från Sverige',
        }),
      ]),
    );
    expect(plan.changes[0].new_slug).toBe(
      'dalahast-i-silver-en-exklusiv-present-fran-sverige',
    );
  });

  it('only collapses a custom slug unrelated to the title', async () => {
    const plan = await buildPlan(
      snap([entity({ slug: 'Summer--Sale-', title: 'Röd tröja' })]),
    );
    expect(plan.changes[0].new_slug).toBe('summer-sale');
    expect(plan.changes[0].reasons).toEqual(['dashes', 'uppercase']);
  });

  it('duplicate pair: PUBLISHED keeps, DRAFT gets -2 without a redirect', async () => {
    const draft = entity({
      slug: 'kaffemugg',
      title: 'Kaffemugg',
      status: 'DRAFT',
      created_at: '2025-01-01T00:00:00.000Z',
    });
    const pub = entity({
      slug: 'kaffemugg',
      title: 'Kaffemugg',
      kind: 'custom_product',
    });
    const plan = await buildPlan(snap([draft, pub]));
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      id: draft.id,
      new_slug: 'kaffemugg-2',
      reasons: ['duplicate'],
      redirect: false,
    });
    expect(plan.redirects).toEqual([]);
  });

  it('two PUBLISHED duplicates: the older keeps; the old path is still served, so no 301', async () => {
    const newer = entity({
      slug: 'ljus',
      title: 'Ljus',
      created_at: '2026-03-01T00:00:00.000Z',
    });
    const older = entity({
      slug: 'ljus',
      title: 'Ljus',
      created_at: '2025-03-01T00:00:00.000Z',
    });
    const plan = await buildPlan(snap([newer, older]));
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      id: newer.id,
      new_slug: 'ljus-2',
      redirect: false,
    });
  });

  it('a repaired slug colliding with existing slugs gets -2 / -3', async () => {
    const plan = await buildPlan(
      snap([
        entity({ slug: 'kopp', title: 'Kopp' }),
        entity({ slug: 'kopp-2', title: 'Kopp' }),
        entity({ slug: 'kopp--', title: 'Kopp' }),
        entity({ slug: '-kopp', title: 'Kopp', status: 'DRAFT' }),
      ]),
    );
    expect(plan.changes.map((c) => [c.old_slug, c.new_slug]).sort()).toEqual([
      ['-kopp', 'kopp-4'],
      ['kopp--', 'kopp-3'],
    ]);
  });

  it('writes 301s only for PUBLISHED rows of a store, with locale prefixes', async () => {
    const pub = entity({ slug: 'Vas', title: 'Vas' });
    pub.translations.push({
      id: 'tr-en',
      locale: 'en',
      title: 'Vase',
      slug: 'Vase',
    });
    const draft = entity({ slug: 'Skal', title: 'Skål', status: 'DRAFT' });
    const pending = entity({
      slug: 'Fat',
      title: 'Fat',
      status: 'PENDING_REVIEW',
    });
    const provider = entity({
      slug: 'Lampa',
      title: 'Lampa',
      creator_id: null,
      provider_id: 'pv-1',
      store: null,
    });
    const plan = await buildPlan(snap([pub, draft, pending, provider]));
    const redirectOf = Object.fromEntries(
      plan.changes.map((c) => [c.old_slug, c.redirect]),
    );
    expect(redirectOf).toEqual({
      Vas: true,
      Vase: true,
      Skal: false,
      Fat: false,
      Lampa: false,
    });
    expect(plan.redirects).toHaveLength(1);
    expect(plan.redirects[0].store_id).toBe('store-1');
    expect(plan.redirects[0].moves).toEqual(
      expect.arrayContaining([
        { from: '/products/Vas', to: '/products/vas' },
        { from: '/products/Vase', to: '/products/vase' },
        { from: '/en/products/Vase', to: '/en/products/vase' },
      ]),
    );
    expect(plan.redirects[0].moves).toHaveLength(3);
  });

  it('provider products are unique per provider', async () => {
    const plan = await buildPlan(
      snap([
        entity({
          slug: 'mugg',
          title: 'Mugg',
          creator_id: null,
          provider_id: 'pv-1',
          store: null,
        }),
        entity({
          slug: 'mugg',
          title: 'Mugg',
          creator_id: null,
          provider_id: 'pv-2',
          store: null,
        }),
        entity({
          slug: 'mugg',
          title: 'Mugg',
          creator_id: null,
          provider_id: 'pv-1',
          store: null,
          status: 'DRAFT',
        }),
      ]),
    );
    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].new_slug).toBe('mugg-2');
  });

  it('categories are lower-cased and unique, never redirected', async () => {
    const plan = await buildPlan(
      snap(
        [],
        [
          { id: 'c1', slug: 'Kitchen', is_active: true, names: ['Kitchen'] },
          { id: 'c2', slug: 'kitchen', is_active: true, names: ['Kitchen'] },
          {
            id: 'c3',
            slug: 'home--decor',
            is_active: false,
            names: ['Home decor'],
          },
        ],
      ),
    );
    expect(
      plan.changes.map((c) => [c.old_slug, c.new_slug, c.redirect]).sort(),
    ).toEqual([
      ['Kitchen', 'kitchen-2', false],
      ['home--decor', 'home-decor', false],
    ]);
  });

  it('is idempotent and the fingerprint is stable', async () => {
    const build = () =>
      snap([
        entity({ id: 'p1', slug: 'a--b', title: 'A B' }),
        entity({ id: 'p2', slug: 'x', title: 'X' }),
        entity({ id: 'p3', slug: 'x', title: 'X', status: 'DRAFT' }),
      ]);
    const s1 = build();
    const s2 = build();
    s2.entities.reverse();
    const p1 = await buildPlan(s1);
    const p2 = await buildPlan(s2);
    expect(fingerprint(p1)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint(p1)).toBe(fingerprint(p2));

    // Apply the plan to the snapshot: the next run has nothing to fix.
    const fixed = build();
    for (const c of p1.changes)
      for (const e of fixed.entities)
        for (const t of e.translations)
          if (t.id === c.row_id) t.slug = c.new_slug;
    const again = await buildPlan(fixed);
    expect(again.changes).toEqual([]);
    expect(renderPlan(again)).toBe('Nothing to fix.');
  });

  it('renders the table and totals', async () => {
    const plan = await buildPlan(
      snap([entity({ slug: 'a--b', title: 'A B' })]),
    );
    const out = renderPlan(plan);
    expect(out).toContain('namez');
    expect(out).toContain('a--b → a-b');
    expect(out).toMatch(/Totals: 1 slugs/);
  });

  it('parses the CLI flags', () => {
    expect(parseArgs([])).toEqual({
      mode: 'dry-run',
      fingerprint: null,
      onlyStore: null,
      includeCategories: false,
    });
    expect(
      parseArgs([
        '--apply',
        '--fingerprint=abc',
        '--only-store=namez',
        '--include-categories',
      ]),
    ).toEqual({
      mode: 'apply',
      fingerprint: 'abc',
      onlyStore: 'namez',
      includeCategories: true,
    });
    expect(() => parseArgs(['--apply'])).toThrow(/fingerprint/);
    expect(() => parseArgs(['--nope'])).toThrow(/Unknown/);
  });
});
