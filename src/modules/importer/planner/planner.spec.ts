/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import type { SnapshotCategory } from './target-snapshot';
import { WpBundleAdapter } from '../adapters/wp-bundle/wp-bundle.adapter';
import { v1Sample } from '../adapters/wp-bundle/__fixtures__/fixtures';
import { PlainTextHtmlSanitizer } from '../html/html-sanitizer';
import { parseFlatRateCost } from '../mapping/map-shipping';
import {
  shippingMethodStateHash,
  shippingProfileStateHash,
  shippingZoneStateHash,
} from '../mapping/state';
import type { NormalizedCatalog } from '../model/normalized';
import { normalizeRunOptions } from '../runs/run-options';
import { applyShipping } from '../apply/apply-shipping';
import { createFakePrisma } from '../__fixtures__/fake-prisma';
import { planImport } from './planner';
import { emptySnapshot, type TargetSnapshot } from './target-snapshot';

const SOURCE = {
  kind: 'WP_BUNDLE' as const,
  site_host: 'shop.example',
  host_aliases: ['old.example'],
  settings: {},
};

async function v1Catalog(): Promise<NormalizedCatalog> {
  return new WpBundleAdapter().load({ bundle: v1Sample(), source: SOURCE });
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
    now: new Date('2026-10-16T00:00:00Z'),
  });
}

describe('planner on the hand-made v1 bundle', () => {
  it('shipping (D26): default + class profile, country zone, flat rate, unsupported locations warned', async () => {
    const p = plan(await v1Catalog());
    const ship = p.work.shipping!;
    expect(ship.profiles.map((x) => [x.mapped.class_slug, x.action])).toEqual([
      [null, 'CREATE'],
      ['stor', 'CREATE'],
    ]);
    const zone = ship.zones.find(
      (z) => z.profile_ref === ship.profiles[0].mapped.ref,
    )!;
    expect(zone.mapped).toMatchObject({
      name: 'Sverige',
      countries: ['SE'],
      base_cost: '49.00',
    });
    expect(
      ship.methods
        .filter((m) => m.zone_ref === zone.mapped.ref)
        .map((m) => [m.mapped.name, m.mapped.type]),
    ).toEqual([['Standard', 'DELIVERY']]);
    expect(p.summary.warnings.W_SHIPPING_LOCATION_UNSUPPORTED.count).toBe(1);
    expect(p.summary.warnings.W_SHIPPING_ZONE_SKIPPED.count).toBe(1); // zone 0
    // Products get the profile of their class.
    const mugg = p.work.products.find((x) => x.mapped.source_id === '10')!;
    expect(mugg.shipping_profile_ref).toBe(ship.profiles[1].mapped.ref);
  });

  it('applies shipping idempotently; the imported default profile becomes default only when none exists', async () => {
    const db: any = createFakePrisma();
    const p = plan(await v1Catalog());
    const ctx = {
      prisma: db,
      storeId: 's',
      creatorId: 'c',
      runId: 'r',
      creatorHasDefaultProfile: false,
      checkpoint: () => Promise.resolve(),
      log: () => Promise.resolve(),
    } as never;
    await applyShipping(ctx, p.work.shipping!, 0, () => Promise.resolve());
    expect(
      db.shippingProfile.rows.map((r: any) => [r.name, r.is_default]),
    ).toEqual([
      ['Standard', true],
      ['Frakt Stor', false],
    ]);
    expect(db.shippingZone.rows).toHaveLength(2);
    expect(db.shippingMethod.rows).toHaveLength(2);
    // Second plan with the ledger written by the apply → all UNCHANGED.
    const ledger = new Map(
      db.importEntity.rows.map((r: any) => [
        `${r.entity_type}|${r.external_ref}`,
        r,
      ]),
    );
    const states = new Map<string, string>();
    for (const r of db.shippingProfile.rows)
      states.set(r.id, shippingProfileStateHash(r));
    for (const r of db.shippingZone.rows)
      states.set(r.id, shippingZoneStateHash(r));
    for (const r of db.shippingMethod.rows)
      states.set(r.id, shippingMethodStateHash(r));
    const again = plan(await v1Catalog(), {
      ledger: ledger as never,
      shippingStates: states,
    });
    expect(
      new Set(
        again.items
          .filter((i) => i.entity_type.startsWith('SHIPPING'))
          .map((i) => i.action),
      ),
    ).toEqual(new Set(['UNCHANGED']));
  });

  it('SKU taken elsewhere on the platform is cleared (W_SKU_CONFLICT_CLEARED)', async () => {
    const p = plan(await v1Catalog(), {
      skuOwners: new Map([
        ['SK-1', { product_id: 'other', external_ref: null }],
      ]),
    });
    const skylt = p.work.products.find((x) => x.mapped.source_id === '20')!;
    expect(skylt.variants.every((v) => v.mapped.sku === null)).toBe(true);
    expect(p.summary.warnings.W_SKU_CONFLICT_CLEARED.count).toBe(1);
  });

  it('scheduled sale is ignored with a warning (D19); entities decoded in names; legacy W_SHIPPING_NOT_IN_BUNDLE absent', async () => {
    const p = plan(await v1Catalog());
    const mugg = p.work.products.find((x) => x.mapped.source_id === '10')!;
    expect([mugg.mapped.base_price, mugg.mapped.compare_at_price]).toEqual([
      '149.00',
      null,
    ]);
    expect(p.summary.warnings.W_SALE_SCHEDULE_IGNORED.count).toBeGreaterThan(0);
    expect(p.work.categories[0].mapped.name).toBe('Muggar & koppar');
    expect(mugg.mapped.translation.description).toBe('<p>Hej<br>rad två</p>');
  });

  it('a category slug owned by another import ref is a CONFLICT; match_existing none also conflicts', async () => {
    const taken = {
      id: 'x',
      slug: 'muggar',
      parent_id: null,
      external_ref: 'woo:other.example:product_cat:1',
      is_active: true,
      state_hash: '',
    };
    const p = plan(await v1Catalog(), {
      categoriesBySlug: new Map([['muggar', taken]]),
    });
    expect(p.items.find((i) => i.entity_type === 'CATEGORY')!.action).toBe(
      'CONFLICT',
    );
    const free = { ...taken, external_ref: null };
    const q = plan(
      await v1Catalog(),
      { categoriesBySlug: new Map([['muggar', free]]) },
      { match_existing: { categories: 'none' } },
    );
    expect(q.items.find((i) => i.entity_type === 'CATEGORY')!.action).toBe(
      'CONFLICT',
    );
  });

  it('M6.7: a live collection this run does not write keeps its live parent chain', async () => {
    // Merchant moved `muggar` under a platform-made `present`; untracked by
    // the ledger, so SKIP_MODIFIED skips it. Its page stays at
    // /collections/present/muggar: redirects target that path and no
    // `renamed` row points at a /collections/muggar that will not exist.
    const parent = {
      id: 'p',
      slug: 'present',
      parent_id: null,
      external_ref: null,
      is_active: true,
      state_hash: '',
    };
    const live = {
      id: 'm',
      slug: 'muggar',
      parent_id: 'p',
      external_ref: 'woo:shop.example:product_cat:50',
      is_active: true,
      state_hash: '',
    };
    const p = plan(await v1Catalog(), {
      categoriesBySlug: new Map<string, SnapshotCategory>([
        ['present', parent],
        ['muggar', live],
      ]),
      categoriesByRef: new Map([[live.external_ref, live]]),
    });
    expect(p.items.find((i) => i.entity_type === 'CATEGORY')!.action).toBe(
      'SKIP',
    );
    const rows = p.work.redirects!.plan.items.map((r) => [
      r.from_path,
      r.to_path,
    ]);
    expect(rows).toContainEqual([
      '/kategori/muggar',
      '/collections/present/muggar',
    ]);
    expect(rows.some(([from]) => from === '/collections/present/muggar')).toBe(
      false,
    );
    expect(rows.some(([, to]) => to === '/collections/muggar')).toBe(false);
  });

  it('Namez Phase 1: a live INTERNAL label is never rewritten and has no collection path', async () => {
    const live = {
      id: 'm',
      slug: 'muggar',
      parent_id: null,
      external_ref: 'woo:shop.example:product_cat:50',
      is_active: true,
      visibility: 'INTERNAL' as const,
      state_hash: '',
    };
    const p = plan(
      await v1Catalog(),
      {
        categoriesBySlug: new Map<string, SnapshotCategory>([['muggar', live]]),
        categoriesByRef: new Map([[live.external_ref, live]]),
      },
      { conflict_policy: 'OVERWRITE' },
    );
    const cat = p.items.find((i) => i.entity_type === 'CATEGORY')!;
    expect(cat.action).toBe('SKIP');
    expect(p.summary.warnings.W_CATEGORY_INTERNAL_SKIPPED.count).toBe(1);
    const rows = p.work.redirects!.plan.items.map((r) => [
      r.from_path,
      r.to_path,
    ]);
    // No row may send the old category URL to a collection path that is
    // not served, and nothing treats /collections/muggar as live.
    expect(rows.some(([, to]) => to === '/collections/muggar')).toBe(false);
    expect(rows.some(([from]) => from === '/kategori/muggar')).toBe(false);
  });

  it('Namez Phase 1: a converted occasion collection redirects to its root page', async () => {
    const live = {
      id: 'm',
      slug: 'muggar',
      parent_id: null,
      external_ref: 'woo:shop.example:product_cat:50',
      is_active: true,
      visibility: 'INTERNAL' as const,
      state_hash: '',
    };
    const ledger = new Map([
      [
        'OCCASION_PAGE|woo:shop.example:product_cat:50',
        {
          id: 'l1',
          entity_type: 'OCCASION_PAGE',
          external_ref: live.external_ref,
          target_id: 'page-1',
          source_hash: 'x',
          applied_hash: 'y',
          created_by_import: true,
          status: 'ACTIVE' as const,
          first_run_id: 'conv',
          last_run_id: 'conv',
        },
      ],
    ]);
    const p = plan(await v1Catalog(), {
      categoriesBySlug: new Map<string, SnapshotCategory>([['muggar', live]]),
      categoriesByRef: new Map([[live.external_ref, live]]),
      ledger,
    });
    const rows = p.work.redirects!.plan.items.map((r) => [
      r.from_path,
      r.to_path,
    ]);
    expect(rows).toContainEqual(['/kategori/muggar', '/muggar']);
    expect(rows.some(([, to]) => to.startsWith('/collections/'))).toBe(false);
  });

  it('scopes switch whole entity types off', async () => {
    const p = plan(
      await v1Catalog(),
      {},
      { scopes: { redirects: false, shipping: false, media: false } },
    );
    const types = new Set(p.items.map((i) => i.entity_type));
    expect(types.has('REDIRECT')).toBe(false);
    expect(types.has('SHIPPING_PROFILE')).toBe(false);
    expect(types.has('MEDIA')).toBe(false);
  });
});

describe('parseFlatRateCost', () => {
  it.each([
    ['49', { base: 49, perItem: 0, formula: false }],
    ['49,50', { base: 49.5, perItem: 0, formula: false }],
    ['[qty] * 10', { base: 0, perItem: 10, formula: false }],
    ['10 * [qty]', { base: 0, perItem: 10, formula: false }],
    ['29 + [qty] * 5', { base: 29, perItem: 5, formula: false }],
    [
      '10 + [fee percent="10" min_fee="5"]',
      { base: 10, perItem: 0, formula: true },
    ],
    ['', { base: 0, perItem: 0, formula: false }],
  ])('%s', (input, out) => expect(parseFlatRateCost(input)).toEqual(out));
});
