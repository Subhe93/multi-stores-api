import {
  buildPlan,
  fingerprint,
  isNoop,
  parseArgs,
  renderPlan,
  type Plan,
  type Snapshot,
} from './convert-legacy-tags.planner';

// Tags rename ops script (plans/tags-rename/PLAN.md §D): legacy ProductTag
// strings of one store → INTERNAL CreatorCategory rows + links.

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    store: {
      id: 'store-1',
      slug: 'muba',
      creator_id: 'cr-1',
      primary_locale: 'sv',
    },
    products: [
      { id: 'p1', title: 'Vegansk tvål', tags: ['Vegan', 'summer', 'new'] },
      { id: 'p2', title: 'Kaffemugg', tags: ['vegan ', 'Summer'] },
      { id: 'p3', title: 'Ljus', tags: ['VEGAN', 'gift-idea', ''] },
    ],
    custom_products: [
      {
        id: 'cp1',
        base_product_id: 'base-1',
        title: 'Tröja',
        tags: ['summer'],
      },
    ],
    internal_rows: [],
    all_slugs: ['presenter', 'new'],
    max_root_sort_order: 4,
    product_links: [],
    custom_product_links: [],
    tags_collections: [],
    ...over,
  };
}

/** Simulates --apply: the created rows become INTERNAL rows and the links exist. */
function afterApply(s: Snapshot, plan: Plan): Snapshot {
  let n = 0;
  const idByKey = new Map<string, string>();
  const internal_rows = [...s.internal_rows];
  for (const t of plan.tags) {
    if (t.action === 'REUSE') idByKey.set(t.key, t.id!);
    else {
      const id = `00000000-0000-4000-8000-00000000000${++n}`;
      idByKey.set(t.key, id);
      internal_rows.push({ id, slug: t.slug!, name: t.name });
    }
  }
  const link = (l: (typeof plan.links)[number]) => ({
    owner_id: l.owner_id,
    creator_category_id: idByKey.get(l.tag_key)!,
    sort_order: l.sort_order,
  });
  return {
    ...s,
    internal_rows,
    all_slugs: [...s.all_slugs, ...internal_rows.map((r) => r.slug)],
    max_root_sort_order: Math.max(
      s.max_root_sort_order,
      ...plan.tags.map((t) => t.sort_order ?? -1),
    ),
    product_links: [
      ...s.product_links,
      ...plan.links.filter((l) => l.kind === 'product').map(link),
    ],
    custom_product_links: [
      ...s.custom_product_links,
      ...plan.links.filter((l) => l.kind === 'custom_product').map(link),
    ],
    tags_collections: s.tags_collections.map((c) => {
      const pc = plan.collections.find((x) => x.id === c.id);
      return pc
        ? {
            ...c,
            match_tags: pc.after.map((v) =>
              v.startsWith('new:') ? idByKey.get(v.slice(4))! : v,
            ),
          }
        : c;
    }),
  };
}

const SUMMER_ID = '0f3a2b1c-1111-4222-8333-444455556666';

describe('convert-legacy-tags planner', () => {
  it('groups tags case-insensitively (trimmed), keeps the most common spelling, WP slugs with suffix, sort_order appended', () => {
    const plan = buildPlan(snap());
    expect(
      plan.tags.map((t) => [t.key, t.name, t.action, t.slug, t.sort_order]),
    ).toEqual([
      ['gift-idea', 'gift-idea', 'CREATE', 'gift-idea', 5],
      // "new" is taken by a collection slug → WP -2 suffix.
      ['new', 'new', 'CREATE', 'new-2', 6],
      ['summer', 'summer', 'CREATE', 'summer', 7],
      // Vegan / vegan / VEGAN: one group; tie on spelling → first seen.
      ['vegan', 'Vegan', 'CREATE', 'vegan', 8],
    ]);
    const vegan = plan.tags.find((t) => t.key === 'vegan')!;
    expect(vegan.product_ids).toEqual(['p1', 'p2', 'p3']);
    const summer = plan.tags.find((t) => t.key === 'summer')!;
    expect(summer.product_ids).toEqual(['p1', 'p2']);
    expect(summer.custom_product_ids).toEqual(['cp1']);
    // Links: one per (owner, tag); sort_order appended per owner.
    expect(
      plan.links
        .filter((l) => l.owner_id === 'p1')
        .map((l) => [l.tag_key, l.sort_order]),
    ).toEqual([
      ['new', 0],
      ['summer', 1],
      ['vegan', 2],
    ]);
    expect(plan.links.filter((l) => l.kind === 'custom_product')).toEqual([
      {
        kind: 'custom_product',
        owner_id: 'cp1',
        tag_key: 'summer',
        sort_order: 0,
      },
    ]);
    expect(plan.counts).toEqual({
      products_with_tags: 3,
      custom_products_with_tags: 1,
      distinct_tags: 4,
      tags_reused: 0,
      tags_created: 4,
      links_existing: 0,
      links_to_add: 8,
      collections_to_convert: 0,
    });
  });

  it('reuses an existing INTERNAL row by primary-locale name (case-insensitive) and skips links already in place', () => {
    const s = snap({
      internal_rows: [
        { id: 'int-vegan', slug: 'vegansk', name: ' VEGAN ' },
        { id: 'int-other', slug: 'other', name: null },
      ],
      product_links: [
        { owner_id: 'p1', creator_category_id: 'int-vegan', sort_order: 3 },
        { owner_id: 'p1', creator_category_id: 'pub-1', sort_order: 0 },
      ],
    });
    const plan = buildPlan(s);
    const vegan = plan.tags.find((t) => t.key === 'vegan')!;
    expect(vegan).toMatchObject({
      action: 'REUSE',
      id: 'int-vegan',
      slug: null,
    });
    // p1 is already linked to the reused row; p2/p3 get the link; p1's next
    // link continues after its highest sort_order.
    const veganLinks = plan.links.filter((l) => l.tag_key === 'vegan');
    expect(veganLinks.map((l) => l.owner_id)).toEqual(['p2', 'p3']);
    expect(
      plan.links.find((l) => l.owner_id === 'p1' && l.tag_key === 'new')!
        .sort_order,
    ).toBe(4);
    expect(plan.counts.links_existing).toBe(1);
    expect(plan.counts.tags_reused).toBe(1);
  });

  it('converts TAGS-rule collections with legacy strings to INTERNAL ids and leaves converted ones alone', () => {
    const s = snap({
      internal_rows: [{ id: SUMMER_ID, slug: 'summer', name: 'Summer' }],
      tags_collections: [
        {
          id: 'col-1',
          slug: 'sommar',
          match_tags: ['summer', 'Vegan', 'old-only'],
        },
        // Already converted: left alone.
        { id: 'col-2', slug: 'done', match_tags: [SUMMER_ID] },
      ],
    });
    const plan = buildPlan(s);
    // "old-only" is carried by no product but the rule needs a row for it.
    expect(plan.tags.find((t) => t.key === 'old-only')).toMatchObject({
      action: 'CREATE',
      product_ids: [],
    });
    expect(plan.collections).toEqual([
      {
        id: 'col-1',
        slug: 'sommar',
        before: ['summer', 'Vegan', 'old-only'],
        after: [SUMMER_ID, 'new:vegan', 'new:old-only'],
      },
    ]);
  });

  it('is idempotent: after an apply the second plan is a no-op with a stable fingerprint', () => {
    const s = snap({
      tags_collections: [
        { id: 'col-1', slug: 'sommar', match_tags: ['summer'] },
      ],
    });
    const first = buildPlan(s);
    expect(isNoop(first)).toBe(false);
    expect(fingerprint(first)).toBe(fingerprint(buildPlan(s)));
    const second = buildPlan(afterApply(s, first));
    expect(isNoop(second)).toBe(true);
    expect(second.counts).toMatchObject({
      tags_created: 0,
      tags_reused: 4,
      links_to_add: 0,
      links_existing: 8,
      collections_to_convert: 0,
    });
  });

  it('parses the CLI and masks product titles in the report', () => {
    expect(parseArgs(['--store', 'muba'])).toEqual({
      store: 'muba',
      mode: 'dry-run',
      fingerprint: null,
    });
    expect(parseArgs(['--store=muba', '--apply', '--fingerprint=abc'])).toEqual(
      {
        store: 'muba',
        mode: 'apply',
        fingerprint: 'abc',
      },
    );
    expect(() => parseArgs(['--apply'])).toThrow('--store');
    expect(() => parseArgs(['--store', 'x', '--bogus'])).toThrow('Unknown');
    const plan = buildPlan(snap());
    const out = renderPlan(plan, new Map([['p1', 'Vegansk tvål']]));
    expect(out).toContain('CREATE "Vegan" slug=vegan');
    expect(out).toContain('"new" slug=new-2');
    expect(out).toContain('Veg…(12)');
    expect(out).not.toContain('Vegansk tvål');
  });
});
