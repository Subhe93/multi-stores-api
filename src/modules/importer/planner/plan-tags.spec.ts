import { ImportEntityStatus } from '@prisma/client';
import { WpBundleAdapter } from '../adapters/wp-bundle/wp-bundle.adapter';
import { v1Sample } from '../adapters/wp-bundle/__fixtures__/fixtures';
import { PlainTextHtmlSanitizer } from '../html/html-sanitizer';
import type { NormalizedCatalog } from '../model/normalized';
import { normalizeRunOptions } from '../runs/run-options';
import { planImport } from './planner';
import {
  emptySnapshot,
  ledgerKey,
  type SnapshotCategory,
  type TargetSnapshot,
} from './target-snapshot';

// Tags rename (2026-11-02): WooCommerce product_tag terms become INTERNAL
// CreatorCategory rows planned as `TAG` entities; products link to them
// through ProductCreatorCategory (tag_refs), never through ProductTag.

const SOURCE = {
  kind: 'WP_BUNDLE' as const,
  site_host: 'shop.example',
  host_aliases: [],
  settings: {},
};

const T1 = 'woo:shop.example:product_tag:901';
const T2 = 'woo:shop.example:product_tag:902';

async function catalogWithTags(): Promise<NormalizedCatalog> {
  const catalog = await new WpBundleAdapter().load({
    bundle: v1Sample(),
    source: SOURCE,
  });
  catalog.tags = [
    {
      ext_id: T1,
      source_id: '901',
      slug: 'present',
      name: ' Present ',
      description_html: '',
      count: 1,
    },
    {
      ext_id: T2,
      source_id: '902',
      slug: 'mugg',
      name: 'Mugg',
      description_html: '',
      count: 1,
    },
  ];
  // The first product carries both tags, the second only the first. No
  // collection links, so the re-run test sees only the tag links.
  const [a, b] = catalog.products;
  a.tag_ext_ids = [T1, T2, T1];
  if (b) b.tag_ext_ids = [T1];
  for (const p of catalog.products) {
    p.category_ext_ids = [];
    p.primary_category_ext_id = null;
  }
  return catalog;
}

function plan(
  catalog: NormalizedCatalog,
  snapshot: Partial<TargetSnapshot> = {},
  options: Record<string, unknown> = {},
) {
  const { options: o, errors } = normalizeRunOptions({
    platform_category_id: 'cat',
    ...options,
  });
  expect(errors).toEqual([]);
  return planImport({
    catalog,
    catalogHash: 'h',
    options: o,
    snapshot: emptySnapshot({ storeId: 's', creatorId: 'c', ...snapshot }),
    sanitizer: new PlainTextHtmlSanitizer(),
    now: new Date('2026-11-02T00:00:00Z'),
  });
}

const snapCat = (
  over: Partial<SnapshotCategory> & { id: string; slug: string },
): SnapshotCategory => ({
  parent_id: null,
  external_ref: null,
  is_active: true,
  visibility: 'PUBLIC',
  state_hash: 'x',
  ...over,
});

describe('planTags (tags rename)', () => {
  it('plans one TAG CREATE per term with cleaned name, WP slug and tag_refs on the products', async () => {
    const p = plan(await catalogWithTags());
    expect(
      p.work.tags.map((t) => [t.mapped.ref, t.action, t.final_slug]),
    ).toEqual([
      [T1, 'CREATE', 'present'],
      [T2, 'CREATE', 'mugg'],
    ]);
    expect(p.work.tags[0].mapped.name).toBe('Present');
    const items = p.items.filter((i) => i.entity_type === 'TAG');
    expect(items.map((i) => [i.external_ref, i.action, i.title])).toEqual([
      [T1, 'CREATE', 'Present'],
      [T2, 'CREATE', 'Mugg'],
    ]);
    expect(p.summary.counts.TAG).toEqual({ CREATE: 2 });
    // Links: distinct refs per product, catalog order.
    const [a, b] = p.work.products;
    expect(a.tag_refs).toEqual([T1, T2]);
    expect(b.tag_refs).toEqual([T1]);
    expect(p.summary.counts.PRODUCT_TAG).toEqual({ CREATE: 3 });
    // Legacy tag names are still mapped (source hash stability) but no
    // ProductTag write is planned for them.
    expect(a.mapped.tags).toEqual(['Present', 'Mugg']);
  });

  it('a slug taken by a collection (live or planned) gets the WP -2 suffix; nothing is planned without the products scope', async () => {
    const catalog = await catalogWithTags();
    const live = snapCat({ id: 'cc-live', slug: 'mugg' });
    const p = plan(catalog, {
      categoriesBySlug: new Map([['mugg', live]]),
    });
    const mugg = p.work.tags.find((t) => t.mapped.ref === T2)!;
    expect(mugg.action).toBe('CREATE');
    expect(mugg.final_slug).toBe('mugg-2');
    expect(p.summary.warnings.W_TAG_SLUG_SUFFIXED.count).toBe(1);

    const off = plan(catalog, {}, { scopes: { products: false } });
    expect(off.work.tags).toEqual([]);
    expect(off.items.filter((i) => i.entity_type === 'TAG')).toEqual([]);
  });

  it('re-run: a tracked, unchanged INTERNAL row is UNCHANGED; a linked product stays UNCHANGED, an unlinked one becomes UPDATE', async () => {
    const catalog = await catalogWithTags();
    const first = plan(catalog);
    const t1 = first.work.tags.find((t) => t.mapped.ref === T1)!;
    const t2 = first.work.tags.find((t) => t.mapped.ref === T2)!;
    const rowOf = (t: typeof t1, id: string) =>
      snapCat({
        id,
        slug: t.final_slug,
        external_ref: t.mapped.ref,
        visibility: 'INTERNAL',
        state_hash: 'applied',
      });
    const ledgerRow = (
      type: string,
      ref: string,
      target: string,
      hash: string,
    ) =>
      [
        ledgerKey(type, ref),
        {
          id: `l-${target}`,
          entity_type: type,
          external_ref: ref,
          target_id: target,
          source_hash: hash,
          applied_hash: 'applied',
          created_by_import: true,
          status: ImportEntityStatus.ACTIVE,
          first_run_id: 'r1',
          last_run_id: 'r1',
        },
      ] as const;
    const [pa, pb] = first.work.products;
    const snapshot: Partial<TargetSnapshot> = {
      categoriesByRef: new Map([
        [T1, rowOf(t1, 'tag-1')],
        [T2, rowOf(t2, 'tag-2')],
      ]),
      categoriesBySlug: new Map([
        [t1.final_slug, rowOf(t1, 'tag-1')],
        [t2.final_slug, rowOf(t2, 'tag-2')],
      ]),
      ledger: new Map([
        ledgerRow('TAG', T1, 'tag-1', t1.source_hash),
        ledgerRow('TAG', T2, 'tag-2', t2.source_hash),
        ledgerRow('PRODUCT', pa.mapped.ref, 'p-a', pa.source_hash),
        ledgerRow('PRODUCT', pb.mapped.ref, 'p-b', pb.source_hash),
      ]),
      productsByRef: new Map([
        [
          pa.mapped.ref,
          {
            id: 'p-a',
            slug: pa.final_slug,
            status: 'PUBLISHED',
            state_hash: 'applied',
          },
        ],
        [
          pb.mapped.ref,
          {
            id: 'p-b',
            slug: pb.final_slug,
            status: 'PUBLISHED',
            state_hash: 'applied',
          },
        ],
      ]),
      // Product A is linked to both tags, product B to none.
      productCategoryLinks: new Map([['p-a', new Set(['tag-1', 'tag-2'])]]),
    };
    const second = plan(catalog, snapshot, { scopes: { media: false } });
    expect(second.work.tags.map((t) => t.action)).toEqual([
      'UNCHANGED',
      'UNCHANGED',
    ]);
    const byRef = new Map(second.work.products.map((p) => [p.mapped.ref, p]));
    expect(byRef.get(pa.mapped.ref)!.action).toBe('UNCHANGED');
    expect(byRef.get(pb.mapped.ref)!.action).toBe('UPDATE');
  });

  it('adopts an INTERNAL row of the same slug without external_ref (match_existing.categories = slug), never a PUBLIC one', async () => {
    const catalog = await catalogWithTags();
    const internal = snapCat({
      id: 'cc-int',
      slug: 'present',
      visibility: 'INTERNAL',
    });
    const pub = snapCat({ id: 'cc-pub', slug: 'mugg' });
    const p = plan(catalog, {
      categoriesBySlug: new Map([
        ['present', internal],
        ['mugg', pub],
      ]),
    });
    const t1 = p.work.tags.find((t) => t.mapped.ref === T1)!;
    expect(t1).toMatchObject({
      action: 'UPDATE',
      adopt: true,
      target_id: 'cc-int',
      final_slug: 'present',
    });
    const t2 = p.work.tags.find((t) => t.mapped.ref === T2)!;
    expect(t2).toMatchObject({ action: 'CREATE', final_slug: 'mugg-2' });
  });
});
