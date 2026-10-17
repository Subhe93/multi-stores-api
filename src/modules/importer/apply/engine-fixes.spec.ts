/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import {
  createFakePrisma,
  MemoryPrivateStorage,
} from '../__fixtures__/fake-prisma';
import { platformWeight, sanitizeValueMeta } from '../mapping/map-product';
import { buildImportRedirects } from '../mapping/map-redirects';
import { decide } from '../planner/planner';
import { normalizeRunOptions } from '../runs/run-options';
import { runOutcome } from '../runs/import-engine.service';
import {
  capRedirectCreates,
  REDIRECT_MAX_ROWS_PER_STORE,
} from '../../redirects/redirects.service';
import { applyShipping } from './apply-shipping';
import { resolveOptionConfig } from './apply-products';
import { rollbackRun } from './rollback';

/** Unit checks of M4.4 fixer A (engine) items. */

const STORE = 's1';
const CREATOR = 'c1';
const RUN = 'run-1';

function ledger(type: string, ref: string, target: string) {
  return {
    id: `${type}-${ref}`,
    store_id: STORE,
    entity_type: type,
    external_ref: ref,
    target_id: target,
    source_hash: 'h',
    applied_hash: null,
    created_by_import: true,
    status: 'ACTIVE',
    first_run_id: RUN,
    last_run_id: RUN,
  };
}

function rollbackDeps(db: any) {
  return {
    prisma: db,
    storage: new MemoryPrivateStorage(),
    uploads: { deleteFile: jest.fn(() => Promise.resolve()) },
    redirects: { invalidate: jest.fn() },
    storeId: STORE,
    creatorId: CREATOR,
    runId: RUN,
    primaryLocale: 'sv',
  };
}

function shippingDb(extraProfile: boolean) {
  const db: any = createFakePrisma();
  db.shippingProfile.rows.push({
    id: 'p1',
    creator_id: CREATOR,
    name: 'Imported',
    is_default: true,
  });
  if (extraProfile)
    db.shippingProfile.rows.push({
      id: 'p-own',
      creator_id: CREATOR,
      name: 'Own',
      is_default: false,
    });
  db.shippingZone.rows.push({ id: 'z1', profile_id: 'p1', name: 'SE' });
  db.shippingMethod.rows.push({ id: 'm1', zone_id: 'z1', name: 'Std' });
  db.importEntity.rows.push(
    ledger('SHIPPING_PROFILE', 'prof', 'p1'),
    ledger('SHIPPING_ZONE', 'zone', 'z1'),
    ledger('SHIPPING_METHOD', 'meth', 'm1'),
  );
  return db;
}

describe('fix 4 — rollback shipping', () => {
  it("keeps the creator's only (default) profile with its zones and methods, even unused", async () => {
    const db = shippingDb(false);
    const res = await rollbackRun(rollbackDeps(db));
    expect(res.shipping_kept).toBe(1);
    expect(db.shippingZone.rows).toHaveLength(1);
    expect(db.shippingMethod.rows).toHaveLength(1);
    expect(db.importEntity.rows.every((e: any) => e.status === 'ACTIVE')).toBe(
      true,
    );
  });

  it('deletes a removable profile together with its zones and methods', async () => {
    const db = shippingDb(true);
    const res = await rollbackRun(rollbackDeps(db));
    expect(res.shipping_deleted).toBe(1);
    expect(db.shippingProfile.rows.map((p: any) => p.id)).toEqual(['p-own']);
    expect(db.shippingZone.rows).toHaveLength(0);
    expect(db.shippingMethod.rows).toHaveLength(0);
    expect(
      db.importEntity.rows.every((e: any) => e.status === 'ROLLED_BACK'),
    ).toBe(true);
  });
});

describe('fix 20 — shipping profile takeover guard', () => {
  it('a CREATE whose profile another worker already created adopts it (advisory lock taken)', async () => {
    const db: any = createFakePrisma();
    const raw = jest.spyOn(db, '$executeRaw');
    db.shippingProfile.rows.push({
      id: 'p-done',
      creator_id: CREATOR,
      name: 'Imported',
      is_default: true,
    });
    db.importEntity.rows.push(ledger('SHIPPING_PROFILE', 'prof', 'p-done'));
    const ctx: any = {
      prisma: db,
      storeId: STORE,
      creatorId: CREATOR,
      runId: 'run-2',
      checkpoint: () => Promise.resolve(),
      log: () => Promise.resolve(),
    };
    await applyShipping(
      ctx,
      {
        profiles: [
          {
            action: 'CREATE',
            target_id: null,
            source_hash: 'h2',
            created_by_import: true,
            mapped: {
              ref: 'prof',
              name: 'Imported',
              class_slug: null,
              zones: [],
            },
          } as any,
        ],
        zones: [],
        methods: [],
      },
      0,
      () => Promise.resolve(),
    );
    expect(raw).toHaveBeenCalled();
    expect(db.shippingProfile.rows).toHaveLength(1);
    expect(db.importEntity.rows[0]).toMatchObject({
      target_id: 'p-done',
      first_run_id: RUN,
    });
  });
});

describe('fix 11 — valueMeta validated like the M4.1 save path', () => {
  it('drops a non-hex badge_color and oversized text, keeps the rest', () => {
    const warnings: string[] = [];
    const out = sanitizeValueMeta(
      { name: 'Färg' },
      {
        Röd: { label: 'Röd', badge_color: 'red' },
        Blå: { badge: 'x'.repeat(5000), badge_color: '#3333dd' },
      },
      (m) => warnings.push(m),
    );
    expect(out).toEqual({
      Röd: { label: 'Röd' },
      Blå: { badge_color: '#3333dd' },
    });
    expect(warnings).toHaveLength(2);
  });
});

describe('fix 16 — weight unit', () => {
  it('maps WooCommerce units and converts ounces to pounds', () => {
    expect(platformWeight(2, 'kg')).toEqual({
      weight: 2,
      unit: 'kg',
      converted: false,
    });
    expect(platformWeight(500, 'g').unit).toBe('g');
    expect(platformWeight(3, 'lbs').unit).toBe('lb');
    expect(platformWeight(16, 'oz')).toEqual({
      weight: 1,
      unit: 'lb',
      converted: true,
    });
    expect(platformWeight(1, null).unit).toBeNull();
  });
});

describe('fix 12 — decide without an ACTIVE ledger', () => {
  const target = { id: 't1', state_hash: 'now' };
  it('an untracked target is SKIP under SKIP_MODIFIED, UPDATE under OVERWRITE', () => {
    expect(decide(undefined, target, 'src', 'SKIP_MODIFIED')).toEqual({
      action: 'SKIP',
      message: 'W_TARGET_UNTRACKED_SKIPPED',
    });
    expect(decide(undefined, target, 'src', 'OVERWRITE').action).toBe('UPDATE');
  });
  it('a rolled-back ledger still compares applied_hash', () => {
    const row: any = {
      target_id: 't1',
      status: 'ROLLED_BACK',
      source_hash: 'src',
      applied_hash: 'then',
    };
    expect(decide(row, target, 'src', 'SKIP_MODIFIED').action).toBe('SKIP');
    expect(
      decide({ ...row, applied_hash: 'now' }, target, 'src', 'SKIP_MODIFIED')
        .action,
    ).toBe('UPDATE');
  });
  it('incomplete is never UNCHANGED (fix 1)', () => {
    const row: any = {
      target_id: 't1',
      status: 'ACTIVE',
      source_hash: 'src',
      applied_hash: 'now',
    };
    expect(decide(row, target, 'src', 'OVERWRITE').action).toBe('UNCHANGED');
    expect(
      decide(row, target, 'src', 'OVERWRITE', { incomplete: true }).action,
    ).toBe('UPDATE');
  });
});

describe('fix 19 — run outcome', () => {
  it('fails on category / shipping errors or > 10 % product errors', () => {
    expect(runOutcome({ PRODUCT: { CREATE: 95, ERROR: 5 } }).failed).toBe(
      false,
    );
    expect(runOutcome({ PRODUCT: { CREATE: 80, ERROR: 20 } }).failed).toBe(
      true,
    );
    expect(runOutcome({ CATEGORY: { ERROR: 1 } }).reasons).toEqual([
      'IMPORT_CATEGORY_ERRORS:1',
    ]);
    expect(runOutcome({ SHIPPING_PROFILE: { ERROR: 1 } }).failed).toBe(true);
  });
});

describe('fix 13 — tag redirects', () => {
  it('a tag on a single draft product goes to / , not to the product page', () => {
    const catalog: any = {
      meta: { bases: { product: 'produkt', category: 'c', tag: 'tag' } },
      categories: [],
      tags: [{ ext_id: 't1', slug: 'gift' }],
    };
    const product: any = {
      ext_id: 'p1',
      slug: 'x',
      old_slugs: [],
      tag_ext_ids: ['t1'],
    };
    const res = buildImportRedirects({
      catalog,
      imported: [{ product, final_slug: 'x', published: false }],
      skipped: [],
      categorySlug: new Map(),
      redirectSkipped: false,
    });
    expect(res.candidates.find((c) => c.rule === 'tag')?.to).toBe('/');
  });
});

describe('M5 B17 — shortlinks and WordPress pages', () => {
  const catalog: any = {
    meta: { bases: { product: 'produkt', category: 'c', tag: 'tag' } },
    categories: [],
    tags: [],
    pages: [
      {
        ext_id: 'pg:7',
        source_id: '7',
        status: 'publish',
        slug: 'om-oss',
        path: ['info', 'om-oss'],
        title: 'Om oss',
      },
      {
        ext_id: 'pg:8',
        source_id: '8',
        status: 'draft',
        slug: 'utkast',
        path: ['utkast'],
        title: 'Utkast',
      },
    ],
  };
  const product: any = {
    ext_id: 'p1',
    source_id: '4256',
    slug: 'x',
    old_slugs: [],
    tag_ext_ids: [],
  };
  const base = {
    catalog,
    imported: [{ product, final_slug: 'x', published: true }],
    skipped: [],
    categorySlug: new Map<string, string>(),
    redirectSkipped: false,
  };

  it('writes `/?p=<id>` rows for published products and pages only when asked', () => {
    const off = buildImportRedirects(base);
    expect(off.candidates.some((c) => c.from.startsWith('/?p='))).toBe(false);
    expect(off.candidates.some((c) => c.rule === 'page')).toBe(false);

    const on = buildImportRedirects({
      ...base,
      shortlinks: true,
      pageTarget: (p) => `/pages/${p.slug}`,
    });
    const by = (from: string) => on.candidates.find((c) => c.from === from);
    expect(by('/?p=4256')).toMatchObject({
      to: '/products/x',
      rule: 'shortlink',
      external_ref: 'p1',
    });
    expect(by('/info/om-oss')).toMatchObject({
      to: '/pages/om-oss',
      rule: 'page',
      external_ref: 'pg:7',
    });
    expect(by('/?p=7')).toMatchObject({
      to: '/pages/om-oss',
      rule: 'shortlink',
    });
    // The draft page and a page the hook declines get nothing.
    expect(on.candidates.some((c) => c.external_ref === 'pg:8')).toBe(false);
    const none = buildImportRedirects({
      ...base,
      shortlinks: true,
      pageTarget: () => null,
    });
    expect(none.candidates.some((c) => c.rule === 'page')).toBe(false);
  });

  it('a draft product gets no shortlink', () => {
    const res = buildImportRedirects({
      ...base,
      imported: [{ product, final_slug: 'x', published: false }],
      shortlinks: true,
    });
    expect(res.candidates.some((c) => c.rule === 'shortlink')).toBe(false);
  });
});

describe('fix 2 — swatches survive an unresolved image', () => {
  it('keeps the current swatch URL when the source swatch was not stored', () => {
    const ctx: any = { media: new Map() };
    const out = resolveOptionConfig(
      ctx,
      [
        {
          name: 'Font',
          style: 'image',
          values: ['A'],
          swatchMap: { A: 'https://namez.se/a.png' },
        },
      ],
      [{ name: 'Font', swatchMap: { A: '/uploads/imports/a.webp' } }],
    ) as any[];
    expect(out[0]).toMatchObject({
      style: 'image',
      swatchMap: { A: '/uploads/imports/a.webp' },
    });
  });
});

describe('redirect cap (REDIRECT_LIMIT)', () => {
  it('creates past the per-store cap become REDIRECT_LIMIT conflicts', () => {
    const plan = capRedirectCreates(
      {
        items: [
          {
            action: 'CREATE',
            id: null,
            from_path: '/a',
            to_path: '/x',
            status_code: 301,
          },
          {
            action: 'CREATE',
            id: null,
            from_path: '/b',
            to_path: '/x',
            status_code: 301,
          },
        ],
        conflicts: [],
        repoints: [],
      },
      REDIRECT_MAX_ROWS_PER_STORE - 1,
    );
    expect(plan.items.map((i) => i.from_path)).toEqual(['/a']);
    expect(plan.conflicts).toEqual([
      { from_path: '/b', to_path: '/x', code: 'REDIRECT_LIMIT' },
    ]);
  });
});

describe('run options (fix 10 / 17)', () => {
  it('validates stock_on_update and preset_help_images', () => {
    expect(normalizeRunOptions({}).options).toMatchObject({
      stock_on_update: 'keep',
      preset_help_images: {},
    });
    expect(
      normalizeRunOptions({
        stock_on_update: 'always',
        preset_help_images: {
          names_equal_length: { name_9: 'https://x/y.jpg' },
          single_name: {},
        },
      }).errors.sort(),
    ).toEqual(
      [
        'preset_help_images.names_equal_length: unknown image name_9',
        'preset_help_images: unknown preset single_name',
        'stock_on_update must be one of: keep, overwrite',
      ].sort(),
    );
  });
});
