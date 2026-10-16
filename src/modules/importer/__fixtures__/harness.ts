/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-return -- in-memory Prisma fake rows are untyped in tests */
import { createHash, randomUUID } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import sharp from 'sharp';
import { NullDesignerImportPort } from '../../../common/ports/designer-import.port';
import { RedirectsService } from '../../redirects/redirects.service';
import {
  SLICE_DIR,
  NAMEZ_RUN_OPTIONS,
} from '../adapters/wp-bundle/__fixtures__/fixtures';
import { isAllowedBundleFile } from '../adapters/wp-bundle/bundle-schema';
import { PlainTextHtmlSanitizer } from '../html/html-sanitizer';
import type {
  PersonalizationPresetPort,
  PresetRequest,
} from '../ports/personalization.port';
import { ImportEngineService } from '../runs/import-engine.service';
import { ImportRunsService } from '../runs/import-runs.service';
import { ImportWorkerService } from '../runs/import-worker.service';
import { ImportSourcesService } from '../sources/import-sources.service';
import type { UploadedBundleFile } from '../runs/bundle-store';
import type { SafeFetchOptions, SafeFetchResponse } from '../media/safe-fetch';
import { createFakePrisma, MemoryPrivateStorage } from './fake-prisma';

/** Test harness: the whole importer on the in-memory Prisma fake (not a spec file). */

export const STORE_ID = '11111111-1111-4111-8111-111111111111';
export const CREATOR_ID = '22222222-2222-4222-8222-222222222222';
export const USER_ID = '33333333-3333-4333-8333-333333333333';
export const PLATFORM_CATEGORY_ID = '44444444-4444-4444-8444-444444444444';

/** §12.2 profile `namez-2026` as run options. */
export const NAMEZ_OPTIONS = {
  platform_category_id: PLATFORM_CATEGORY_ID,
  skip_ext_ids: NAMEZ_RUN_OPTIONS.skip_ext_ids,
  include_drafts: true,
  status_map: NAMEZ_RUN_OPTIONS.status_map,
  conflict_policy: 'SKIP_MODIFIED',
  on_source_removed: 'keep',
  match_existing: { categories: 'slug', products: 'none' },
  customization_type_rules: NAMEZ_RUN_OPTIONS.customization_type_rules,
  term_cleanup: {
    strip_price_suffix: true,
    strip_trailing_colon: true,
    unicode: true,
  },
  label_overrides: { pa_namnskylt_stor_bokstav: 'Välj antal' },
  faq_labels: {
    product_care_instructions: 'Skötselråd',
    product_size_fit: 'Storlek & passform',
    product_delivery: 'Leverans',
  },
  shipping: {
    method_names: { flat_rate: 'Standardfrakt (Skickas inom 2-4 arbetsdagar)' },
    default_days: { min: 2, max: 4 },
    free_shipping_as_threshold: true,
  },
  designer_fallback_fields: true,
  redirect_skipped: true,
  verify_media: false,
};

export function filesOf(dir: string): UploadedBundleFile[] {
  return readdirSync(dir)
    .filter((n) => isAllowedBundleFile(n))
    .map((n) => {
      const buffer = readFileSync(join(dir, n));
      return { originalname: n, buffer, size: buffer.length };
    });
}

const pngCache = new Map<string, Buffer>();
/** A distinct 2×2 PNG per seed (so sha256 dedupe behaves like real files). */
export async function tinyPng(seed = ''): Promise<Buffer> {
  const hit = pngCache.get(seed);
  if (hit) return hit;
  const h = createHash('sha256').update(seed).digest();
  const buf = await sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: h[0], g: h[1], b: h[2] },
    },
  })
    .png()
    .toBuffer();
  pngCache.set(seed, buf);
  return buf;
}

export async function makeHarness(
  opts: {
    personalization?: boolean;
    failMedia?: (url: string) => boolean;
  } = {},
) {
  const db: any = createFakePrisma();
  db.creator.rows.push({
    id: CREATOR_ID,
    user_id: USER_ID,
    store: { id: STORE_ID },
  });
  db.store.rows.push({
    id: STORE_ID,
    creator_id: CREATOR_ID,
    slug: 'namez',
    currency: 'SEK',
    store_type: 'INDEPENDENT',
    tax_pricing_mode: 'INCLUSIVE',
    is_active: true,
    language_config: { primary_locale: 'sv' },
  });
  db.market.rows.push({
    id: randomUUID(),
    store_id: STORE_ID,
    is_default: true,
    currency: 'SEK',
  });
  db.category.rows.push({ id: PLATFORM_CATEGORY_ID, slug: 'gifts' });
  db.user.rows.push({ id: USER_ID, email: 'owner@example.com' });

  const storage = new MemoryPrivateStorage();
  const stored: string[] = [];
  const uploads = {
    storeBuffer: jest.fn((_b: Buffer, _ext: string, folder = 'general') => {
      const url = `/uploads/${folder}/${randomUUID()}.webp`;
      stored.push(url);
      return Promise.resolve({ url, file_type: 'image', file_size: 1 });
    }),
    deleteFile: jest.fn(() => Promise.resolve()),
  };
  const redirects = new RedirectsService(db as never);
  const revalidation = {
    revalidateStoreById: jest.fn(() => Promise.resolve()),
  };
  const presetCalls: { productId: string; reqs: PresetRequest[] }[] = [];
  const personalization: PersonalizationPresetPort = {
    isAvailable: jest.fn(() => Promise.resolve(opts.personalization !== false)),
    applyPresets: jest.fn(
      async (tx: any, productId: string, reqs: PresetRequest[]) => {
        presetCalls.push({ productId, reqs });
        const out: {
          source_ref: string;
          field_ids: string[];
          skipped: string[];
          replaced: number;
        }[] = [];
        for (const r of reqs) {
          const f = await tx.productCustomField.create({
            data: {
              product_id: productId,
              name: `${r.key}_${randomUUID().slice(0, 4)}`,
              type: 'TEXT',
              preset_key: r.key,
              preset_ref: r.source_ref,
            },
          });
          out.push({
            source_ref: r.source_ref,
            field_ids: [f.id],
            skipped: [],
            replaced: 0,
          });
        }
        return out;
      },
    ),
  };
  const designer = new NullDesignerImportPort();
  const sanitizer = new PlainTextHtmlSanitizer();
  const engine = new ImportEngineService(
    db as never,
    storage,
    uploads as never,
    redirects,
    revalidation as never,
    personalization,
    designer,
    sanitizer,
  );
  const fetched: string[] = [];
  const fetcher = {
    get: jest.fn(
      async (url: string, _o: SafeFetchOptions): Promise<SafeFetchResponse> => {
        fetched.push(url);
        if (opts.failMedia?.(url))
          return { status: 404, headers: {}, body: Buffer.alloc(0), url };
        return {
          status: 200,
          headers: {},
          body: await tinyPng(url.replace(/-scaled(\.[a-z]+)$/, '$1')),
          url,
        };
      },
    ),
  };
  jest.spyOn(engine, 'fetcherFor').mockReturnValue(fetcher as never);
  const crypto = {
    encrypt: (s: string) => `enc:${s}`,
    decrypt: (s: string | null) => (s ? s.replace(/^enc:/, '') : null),
  };
  const sources = new ImportSourcesService(
    db as never,
    crypto as never,
    storage,
  );
  const runs = new ImportRunsService(db as never, storage, sources, engine);
  const worker = new ImportWorkerService(db as never, engine);

  const source = await sources.create(STORE_ID, {
    kind: 'WP_BUNDLE',
    name: 'namez.se',
    site_url: 'https://namez.se',
    host_aliases: ['3dnamez.se'],
    settings: {
      product_base: 'produkt',
      category_base: 'product-category',
      tag_base: 'product-tag',
      locale: 'sv',
      currency: 'SEK',
    },
  });

  /** Upload + dry run; returns the PLANNED run. */
  const dryRun = async (
    options: Record<string, unknown> = NAMEZ_OPTIONS,
    dir = SLICE_DIR,
  ) => {
    const run = await runs.create(
      STORE_ID,
      USER_ID,
      source.id,
      options,
      filesOf(dir),
    );
    await worker.tick();
    return runs.detail(STORE_ID, run.id);
  };
  /** Confirm + apply; returns the finished run. */
  const apply = async (runId: string) => {
    const r = await runs.detail(STORE_ID, runId);
    await runs.confirm(STORE_ID, USER_ID, runId, r.plan_fingerprint!);
    await worker.tick();
    return runs.detail(STORE_ID, runId);
  };
  const itemsOf = (
    runId: string,
    phase: 'PLAN' | 'APPLY' | 'ROLLBACK',
  ): any[] =>
    db.importRunItem.rows.filter(
      (i: any) => i.run_id === runId && i.phase === phase,
    );

  return {
    db,
    storage,
    uploads,
    stored,
    redirects,
    revalidation,
    personalization,
    presetCalls,
    designer,
    engine,
    fetcher,
    fetched,
    sources,
    runs,
    worker,
    source,
    dryRun,
    apply,
    itemsOf,
  };
}
