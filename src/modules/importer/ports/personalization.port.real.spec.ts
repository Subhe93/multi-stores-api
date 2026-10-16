/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-argument -- in-memory Prisma fake rows are untyped in tests */
import { existsSync } from 'fs';
import { join } from 'path';
import { PersonalizationPresetsService } from '../../personalization/personalization-presets.service';
import {
  NAMEZ_EXPORT_DIR,
  SLICE_DIR,
} from '../adapters/wp-bundle/__fixtures__/fixtures';
import {
  makeHarness,
  NAMEZ_OPTIONS,
  STORE_ID,
  USER_ID,
} from '../__fixtures__/harness';
import { PersonalizationPresetPortAdapter } from './personalization.port';

/**
 * Fix 25: the importer's presets through the REAL M4.1
 * `PersonalizationPresetsService.applyInTx` (+ `resolvePresetParams`) and
 * the real port adapter — not the fake port — on the Namez slice, and on
 * the 14 presets of the full export when NAMEZ_EXPORT_DIR is present.
 * The in-memory Prisma fake gets a thin transaction view for the two calls
 * it cannot express (a nested select and a nested create).
 */

function txView(db: any): any {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === 'product')
        return {
          ...target.product,
          findUnique: async (args: any) => {
            const p = await target.product.findUnique({ where: args.where });
            if (!p) return null;
            const creator = target.creator.rows.find(
              (c: any) => c.id === p.creator_id,
            );
            const store = target.store.rows.find(
              (s: any) => s.creator_id === p.creator_id,
            );
            return {
              id: p.id,
              creator_id: p.creator_id,
              variant_option_config: p.variant_option_config,
              creator: creator
                ? {
                    user_id: creator.user_id,
                    store: { language_config: store?.language_config ?? null },
                  }
                : null,
            };
          },
        };
      if (prop === 'productCustomField')
        return new Proxy(target.productCustomField, {
          get(model, p) {
            if (p !== 'create') return Reflect.get(model, p);
            return async (args: any) => {
              const { translations, ...data } = args.data;
              const row = await model.create({ data });
              const trs: any[] = [];
              for (const t of translations?.create ?? [])
                trs.push(
                  await target.customFieldTranslation.create({
                    data: { ...t, field_id: row.id },
                  }),
                );
              return { ...row, translations: trs };
            };
          },
        });
      return Reflect.get(target, prop);
    },
  });
}

async function realHarness() {
  const h = await makeHarness();
  const service = new PersonalizationPresetsService(h.db as never);
  const adapter = new PersonalizationPresetPortAdapter(service, {
    isEnabled: () => Promise.resolve(true),
  } as never);
  const calls: string[] = [];
  const port = {
    isAvailable: () => Promise.resolve(true),
    applyPresets: (tx: any, productId: string, reqs: any[]) => {
      calls.push(...reqs.map((r) => r.key));
      return adapter.applyPresets(txView(tx), productId, reqs);
    },
  };
  (h.engine as any).personalization = port;
  return { ...h, calls };
}

type Item = { entity_type: string; external_ref: string; action: string };
const keys = (items: Item[]) =>
  new Set(items.map((i) => `${i.entity_type}|${i.external_ref}|${i.action}`));

async function runOn(dir: string, expected: number) {
  const h = await realHarness();
  const run = await h.dryRun(
    {
      ...NAMEZ_OPTIONS,
      preset_help_images: {
        names_equal_length: {
          name_1:
            'https://namez.se/wp-content/uploads/2024/09/left-3dnamez.jpg',
        },
      },
    },
    dir,
  );
  const done = await h.apply(run.id);
  expect(done.status).toMatch(/^COMPLETED/);
  expect(keys(h.itemsOf(run.id, 'APPLY'))).toEqual(
    keys(h.itemsOf(run.id, 'PLAN')),
  );
  expect(h.calls).toHaveLength(expected);
  const errors = h
    .itemsOf(run.id, 'APPLY')
    .filter((i: any) => i.action === 'ERROR' && i.entity_type !== 'MEDIA');
  expect(errors).toEqual([]);
  // Every preset made real fields tagged with the importer's source ref.
  const fields = h.db.productCustomField.rows.filter(
    (f: any) => f.preset_ref && f.preset_key !== 'npp_fallback',
  );
  const refs = new Set(fields.map((f: any) => f.preset_ref));
  expect(refs.size).toBe(expected);
  const two = fields.filter((f: any) => f.preset_key === 'names_equal_length');
  if (two.length) {
    expect(two.map((f: any) => f.name)).toEqual(
      expect.arrayContaining(['name_1', 'name_2', 'model_text']),
    );
    const n1 = two.find((f: any) => f.name === 'name_1');
    const tr = h.db.customFieldTranslation.rows.find(
      (t: any) => t.field_id === n1.id,
    );
    expect(tr.help_image_url).toMatch(/^\/uploads\/imports\//);
  }
  // A re-run applies nothing again; rollback removes every preset field.
  h.calls.length = 0;
  const again = await h.dryRun(NAMEZ_OPTIONS, dir);
  await h.runs.cancel(STORE_ID, again.id);
  await h.runs.rollback(STORE_ID, USER_ID, run.id);
  await h.worker.tick();
  expect(
    h.db.productCustomField.rows.filter((f: any) => f.preset_ref),
  ).toHaveLength(0);
}

describe('real PersonalizationPresetsService through the importer port (fix 25)', () => {
  it('Namez slice: 7 presets apply for real', async () => {
    await runOn(SLICE_DIR, 7);
  });

  const full = existsSync(join(NAMEZ_EXPORT_DIR, 'posts.tsv'));
  (full ? it : it.skip)(
    'full Namez export: the 14 presets apply for real',
    async () => {
      await runOn(NAMEZ_EXPORT_DIR, 14);
    },
  );
});
