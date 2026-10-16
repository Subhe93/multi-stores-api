/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import { existsSync } from 'fs';
import { join } from 'path';
import { NAMEZ_EXPORT_DIR } from '../adapters/wp-bundle/__fixtures__/fixtures';
import { makeHarness, NAMEZ_OPTIONS } from '../__fixtures__/harness';

/**
 * Full read-only Namez export (legacy bundle, 2026-10-15) through the whole
 * importer on the in-memory Prisma fake: the dry run must match M4.4 §12.3,
 * apply must equal the plan, and a second run must be all UNCHANGED.
 * Client data is not in the repository: set NAMEZ_EXPORT_DIR; skipped when
 * the directory is absent.
 */
const available = existsSync(join(NAMEZ_EXPORT_DIR, 'posts.tsv'));
const describeIfExport = available ? describe : describe.skip;

type Item = { entity_type: string; external_ref: string; action: string };
const keys = (items: Item[]) =>
  new Set(items.map((i) => `${i.entity_type}|${i.external_ref}|${i.action}`));

describeIfExport('Namez full export — dry run, apply, re-run (§12.3)', () => {
  it('matches the §12.3 counts, PLAN == APPLY, second run UNCHANGED', async () => {
    const h = await makeHarness();
    const run = await h.dryRun(NAMEZ_OPTIONS, NAMEZ_EXPORT_DIR);
    expect(run.status).toBe('PLANNED');
    const c = (run.summary as any).counts;
    expect(c.PRODUCT).toEqual({ CREATE: 35, SKIP: 1 });
    expect(c.VARIANT).toEqual({ CREATE: 232 });
    expect(c.CATEGORY).toEqual({ CREATE: 78 });
    expect(c.PRODUCT_CATEGORY).toEqual({ CREATE: 239 });
    expect(c.TAG).toEqual({ CREATE: 11 });
    // §12.3 lists 9; 4414 size_fit holds only "[namez_card]", which is removed → empty → W_FAQ_EMPTY_SKIPPED.
    expect(c.FAQ).toEqual({ CREATE: 8 });
    expect(c.OPTION_CONFIG).toEqual({ CREATE: 10 });
    expect(c.PERSONALIZATION).toEqual({ CREATE: 14, SKIP: 1 });
    expect(c.FALLBACK_FIELD).toEqual({ CREATE: 24 });
    expect(c.DESIGN_TEMPLATE).toEqual({ STAGE: 10 });
    expect(c.REDIRECT).toEqual({ CREATE: 194 });
    expect((run.summary as any).plan.blockers).toEqual([]);

    const done = await h.apply(run.id);
    expect(done.status).toBe('COMPLETED_WITH_WARNINGS');
    expect(keys(h.itemsOf(run.id, 'APPLY'))).toEqual(
      keys(h.itemsOf(run.id, 'PLAN')),
    );
    expect(h.db.product.rows).toHaveLength(35);
    expect(h.db.productVariant.rows).toHaveLength(232);
    expect(
      h.db.productVariant.rows.filter((v: any) => !v.is_active),
    ).toHaveLength(1);
    expect(h.db.creatorCategory.rows).toHaveLength(78);
    expect(
      h.db.creatorCategory.rows.every(
        (x: any) => x.is_active && x.noindex_when_empty,
      ),
    ).toBe(true);
    expect(h.db.storeRedirect.rows).toHaveLength(194);
    expect(
      h.db.productCustomField.rows.filter(
        (f: any) => f.preset_key === 'npp_fallback',
      ),
    ).toHaveLength(72);
    expect(
      h.db.productTranslation.rows.filter((t: any) => t.short_description),
    ).toHaveLength(35);
    expect(
      h.db.productTranslation.rows.filter((t: any) => t.meta_desc),
    ).toHaveLength(35);
    expect(
      h.db.creatorCategoryTranslation.rows.filter(
        (t: any) => t.meta_title || t.meta_desc,
      ),
    ).toHaveLength(46);

    const second = await h.dryRun(NAMEZ_OPTIONS, NAMEZ_EXPORT_DIR);
    for (const [type, actions] of Object.entries(
      (second.summary as any).counts,
    )) {
      for (const a of Object.keys(actions as object)) {
        if (type === 'PRODUCT' || type === 'PERSONALIZATION')
          expect(['UNCHANGED', 'SKIP']).toContain(a);
        else expect(a).toBe('UNCHANGED');
      }
    }
  }, 120_000);
});
