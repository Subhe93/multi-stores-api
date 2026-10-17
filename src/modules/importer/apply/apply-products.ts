import {
  CustomFieldType,
  ImportEntityStatus,
  ImportItemPhase,
  ImportLogLevel,
  Prisma,
  ProductStatus,
} from '@prisma/client';
import { lockProductFields } from '../../personalization/personalization-field-writer';
import {
  productMediaRefs,
  rewriteInlineImages,
  type MappedOptionConfig,
} from '../mapping/map-product';
import { productStateHash, type ProductStateRows } from '../mapping/state';
import { loadProductStateRows } from '../planner/state-loader';
import type {
  PlannedPreset,
  PlannedProduct,
  PlannedRemoval,
} from '../planner/planner';
import type { IncompleteInfo } from '../planner/target-snapshot';
import type { PresetRequest } from '../ports/personalization.port';
import {
  appliedRefs,
  errorMessage,
  ledgerBefore,
  PRODUCT_TX_TIMEOUT_MS,
  publicUrlOf,
  recordItems,
  upsertLedger,
  type ApplyContext,
  type ApplyItem,
  type LedgerBefore,
  type Tx,
} from './apply-context';

/** Products per checkpoint (M4.4 §9.1); each product has its own transaction. */
export const PRODUCT_BATCH = 25;

export const NPP_FALLBACK_PRESET_KEY = 'npp_fallback';

/** D28 launch fields while the designer is not available (Q10: both texts required, max 40). */
export const NPP_FALLBACK_FIELD_DEFS = [
  {
    name: 'npp_namn',
    type: CustomFieldType.TEXT,
    label: 'Namn',
    required: true,
    rules: { max_length: 40 },
  },
  {
    name: 'npp_klass',
    type: CustomFieldType.TEXT,
    label: 'Klass',
    required: true,
    rules: { max_length: 40 },
  },
  {
    name: 'npp_foto',
    type: CustomFieldType.IMAGE,
    label: 'Foto',
    required: true,
    rules: null,
  },
] as const;

export interface ProductLookups {
  categoryIdByRef: Map<string, string>;
  /** Collections the importer owns (links to them are managed). */
  importedCategoryIds: Set<string>;
  profileIdByRef: Map<string, string>;
}

/** Managed rows of a product before an UPDATE (D7; restored by rollback, fix 6). */
export interface ProductBefore {
  state: ProductStateRows;
  weight_unit: string | null;
  links: { creator_category_id: string; sort_order: number }[];
  ledger: LedgerBefore | null;
}

export async function loadProductLookups(
  ctx: ApplyContext,
): Promise<ProductLookups> {
  const cats = await ctx.prisma.creatorCategory.findMany({
    where: { creator_id: ctx.creatorId, external_ref: { not: null } },
    select: { id: true, external_ref: true },
  });
  const profiles = await ctx.prisma.importEntity.findMany({
    where: {
      store_id: ctx.storeId,
      entity_type: 'SHIPPING_PROFILE',
      status: ImportEntityStatus.ACTIVE,
    },
    select: { external_ref: true, target_id: true },
  });
  return {
    categoryIdByRef: new Map(cats.map((c) => [c.external_ref!, c.id])),
    importedCategoryIds: new Set(cats.map((c) => c.id)),
    profileIdByRef: new Map(
      profiles
        .filter((p) => p.target_id)
        .map((p) => [p.external_ref, p.target_id!]),
    ),
  };
}

/**
 * Option config as written: swatch source URLs → uploaded URLs (D14). A
 * swatch that could not be stored keeps the URL the option has now (`current`,
 * fix 2), so a run without media never wipes swatches.
 */
export function resolveOptionConfig(
  ctx: ApplyContext,
  config: MappedOptionConfig[] | null,
  current?: unknown,
): Prisma.InputJsonValue | undefined {
  if (!config) return undefined;
  const currentSwatches = new Map<string, Record<string, string>>();
  if (Array.isArray(current))
    for (const o of current as { name?: unknown; swatchMap?: unknown }[])
      if (
        o &&
        typeof o.name === 'string' &&
        o.swatchMap &&
        typeof o.swatchMap === 'object'
      )
        currentSwatches.set(o.name, o.swatchMap as Record<string, string>);
  return config.map((o) => {
    const out: Record<string, unknown> = {
      name: o.name,
      style: o.style,
      values: o.values,
    };
    if (o.colorMap) out.colorMap = o.colorMap;
    if (o.swatchMap) {
      const resolved: Record<string, string> = {};
      const kept = currentSwatches.get(o.name) ?? {};
      for (const [value, src] of Object.entries(o.swatchMap)) {
        const url = publicUrlOf(ctx, src) ?? kept[value];
        if (typeof url === 'string' && url) resolved[value] = url;
      }
      if (Object.keys(resolved).length) out.swatchMap = resolved;
      else if (o.style === 'image') out.style = o.valueMeta ? 'card' : 'text';
    }
    if (o.valueMeta) out.valueMeta = o.valueMeta;
    return out;
  }) as Prisma.InputJsonValue;
}

function html(ctx: ApplyContext, s: string): string {
  return rewriteInlineImages(s, (src) => publicUrlOf(ctx, src), ctx.siteHost);
}

async function loadProductBefore(
  tx: Tx,
  ctx: ApplyContext,
  productId: string,
  ref: string,
): Promise<ProductBefore> {
  const state = (
    await loadProductStateRows(tx, [productId], ctx.primaryLocale)
  ).get(productId);
  if (!state) throw new Error(`product ${productId} no longer exists`);
  const [extra, links, ledger] = await Promise.all([
    tx.product.findUnique({
      where: { id: productId },
      select: { weight_unit: true },
    }),
    tx.productCreatorCategory.findMany({
      where: { product_id: productId },
      select: { creator_category_id: true, sort_order: true },
    }),
    ledgerBefore(tx, ctx, 'PRODUCT', ref),
  ]);
  return { state, weight_unit: extra?.weight_unit ?? null, links, ledger };
}

interface WriteResult {
  productId: string;
  incomplete: IncompleteInfo | null;
  before: ProductBefore | null;
}

async function writeProductRows(
  tx: Tx,
  ctx: ApplyContext,
  pp: PlannedProduct,
  lookups: ProductLookups,
): Promise<WriteResult> {
  const m = pp.mapped;
  const creating = pp.action === 'CREATE';
  const before = creating
    ? null
    : await loadProductBefore(tx, ctx, pp.target_id!, m.ref);
  const optionConfig = resolveOptionConfig(
    ctx,
    m.option_config,
    before?.state.product.variant_option_config,
  );
  const profileId = pp.shipping_profile_ref
    ? lookups.profileIdByRef.get(pp.shipping_profile_ref)
    : undefined;
  // Fix 17: platform stock is kept on UPDATE unless the run says otherwise.
  const writeStock = creating || ctx.options.stock_on_update === 'overwrite';
  const scalars = {
    status: m.status as ProductStatus,
    product_type: m.product_type,
    customization_type: m.customization_type,
    base_price: m.base_price,
    compare_at_price: m.compare_at_price,
    sku: m.sku,
    track_inventory: m.track_inventory,
    ...(writeStock ? { stock_quantity: m.stock_quantity } : {}),
    weight: m.weight,
    ...(m.weight_unit ? { weight_unit: m.weight_unit } : {}),
    tax_exempt: m.tax_exempt,
    category_id: ctx.options.platform_category_id!,
    variant_option_config: optionConfig ?? Prisma.DbNull,
    ...(profileId ? { shipping_profile_id: profileId } : {}),
  };
  const translation = {
    title: m.translation.title,
    slug: pp.final_slug,
    description: html(ctx, m.translation.description),
    short_description: m.translation.short_description
      ? html(ctx, m.translation.short_description)
      : null,
    meta_title: m.translation.meta_title,
    meta_desc: m.translation.meta_desc,
  };

  let productId: string;
  if (creating) {
    const row = await tx.product.create({
      data: { ...scalars, creator_id: ctx.creatorId, external_ref: m.ref },
      select: { id: true },
    });
    productId = row.id;
    await tx.productTranslation.create({
      data: {
        ...translation,
        product_id: productId,
        locale: ctx.primaryLocale,
      },
    });
  } else {
    productId = pp.target_id!;
    await tx.product.update({
      where: { id: productId },
      data: { ...scalars, external_ref: m.ref },
    });
    await tx.productTranslation.upsert({
      where: {
        product_id_locale: { product_id: productId, locale: ctx.primaryLocale },
      },
      create: {
        ...translation,
        product_id: productId,
        locale: ctx.primaryLocale,
      },
      update: translation,
    });
  }

  // Variants: matched by external_ref; removed ones deactivated (D6).
  for (const v of pp.variants) {
    const data = {
      sku: v.mapped.sku,
      price_adjustment: v.mapped.price_adjustment,
      compare_at_price: v.mapped.compare_at_price,
      is_active: v.mapped.is_active,
      options: v.mapped.options,
    };
    if (v.action === 'CREATE' || !v.target_id) {
      const row = await tx.productVariant.create({
        data: {
          ...data,
          stock_quantity: v.mapped.stock_quantity,
          product_id: productId,
          external_ref: v.mapped.ref,
        },
        select: { id: true },
      });
      v.target_id = row.id;
    } else if (v.action === 'UPDATE') {
      await tx.productVariant.update({
        where: { id: v.target_id },
        data: writeStock
          ? { ...data, stock_quantity: v.mapped.stock_quantity }
          : data,
      });
    }
  }
  for (const d of pp.deactivate) {
    await tx.productVariant.update({
      where: { id: d.id },
      data: { is_active: false },
    });
  }

  // Images (product level). An image that could not be stored is missing
  // (fix 1); without the media scope existing images are left alone (fix 2).
  const resolved = m.images.map((img) => ({
    url: publicUrlOf(ctx, img.source_url),
    alt: img.alt,
    source: img.source_url,
  }));
  const missingMedia = productMediaRefs(m)
    .map((i) => i.source_url)
    .filter((u) => !publicUrlOf(ctx, u));
  const keepImages =
    !creating && !ctx.options.scopes.media && resolved.some((i) => !i.url);
  if (!creating) {
    if (!keepImages)
      await tx.productImage.deleteMany({
        where: { product_id: productId, variant_id: null },
      });
    await tx.productTag.deleteMany({ where: { product_id: productId } });
    const faqs = await tx.productFaq.findMany({
      where: { product_id: productId },
      select: { id: true },
    });
    if (faqs.length) {
      await tx.productFaqTranslation.deleteMany({
        where: { faq_id: { in: faqs.map((f) => f.id) } },
      });
      await tx.productFaq.deleteMany({ where: { product_id: productId } });
    }
  }
  const images = resolved.filter(
    (i): i is { url: string; alt: string | null; source: string } => !!i.url,
  );
  if (images.length && !keepImages) {
    await tx.productImage.createMany({
      data: images.map((img, i) => ({
        product_id: productId,
        url: img.url,
        alt_text: img.alt,
        sort_order: i,
        is_featured: i === 0,
      })),
    });
  }
  if (m.tags.length) {
    await tx.productTag.createMany({
      data: m.tags.map((tag) => ({ product_id: productId, tag })),
    });
  }
  const wanted = new Map<string, number>();
  const missingCategories: string[] = [];
  for (const ref of m.category_refs) {
    const id = lookups.categoryIdByRef.get(ref);
    if (id) wanted.set(id, pp.positions[ref] ?? 0);
    else missingCategories.push(ref);
  }
  if (!creating) {
    const stale = [...lookups.importedCategoryIds].filter(
      (id) => !wanted.has(id),
    );
    if (stale.length) {
      await tx.productCreatorCategory.deleteMany({
        where: { product_id: productId, creator_category_id: { in: stale } },
      });
    }
  }
  for (const [catId, pos] of wanted) {
    await tx.productCreatorCategory.upsert({
      where: {
        product_id_creator_category_id: {
          product_id: productId,
          creator_category_id: catId,
        },
      },
      create: {
        product_id: productId,
        creator_category_id: catId,
        sort_order: pos,
      },
      update: { sort_order: pos },
    });
  }
  for (const [i, f] of m.faqs.entries()) {
    const faq = await tx.productFaq.create({
      data: { product_id: productId, sort_order: i },
      select: { id: true },
    });
    await tx.productFaqTranslation.create({
      data: {
        faq_id: faq.id,
        locale: ctx.primaryLocale,
        question: f.question,
        answer: html(ctx, f.answer),
      },
    });
  }
  // A category that is not on the platform (CONFLICT, scope off) cannot be
  // repaired by a re-run, so only media count as incomplete for categories
  // that do exist (the planner re-checks links itself).
  const incomplete: IncompleteInfo | null =
    missingMedia.length || missingCategories.length
      ? {
          ...(missingMedia.length ? { media: missingMedia.slice(0, 50) } : {}),
          ...(missingCategories.length
            ? { categories: missingCategories.slice(0, 50) }
            : {}),
        }
      : null;
  return { productId, incomplete, before };
}

/** D28 fallback fields; returns true when this call created any. */
async function writeFallbackFields(
  tx: Tx,
  ctx: ApplyContext,
  productId: string,
  ref: string,
): Promise<boolean> {
  // Same per-product lock as every other field writer (fix 15).
  await lockProductFields(tx, productId);
  const existing = await tx.productCustomField.findMany({
    where: { product_id: productId },
    select: { name: true, preset_key: true, sort_order: true },
  });
  if (existing.some((f) => f.preset_key === NPP_FALLBACK_PRESET_KEY))
    return false;
  let sort = existing.reduce((mx, f) => Math.max(mx, f.sort_order), -1) + 1;
  const names = new Set(existing.map((f) => f.name));
  let created = false;
  for (const def of NPP_FALLBACK_FIELD_DEFS) {
    if (names.has(def.name)) continue;
    const field = await tx.productCustomField.create({
      data: {
        product_id: productId,
        name: def.name,
        type: def.type,
        is_required: def.required,
        ...(def.rules ? { validation_rules: def.rules } : {}),
        sort_order: sort++,
        preset_key: NPP_FALLBACK_PRESET_KEY,
        preset_ref: ref.slice(0, 191),
      },
      select: { id: true },
    });
    await tx.customFieldTranslation.create({
      data: { field_id: field.id, locale: ctx.primaryLocale, label: def.label },
    });
    created = true;
  }
  return created;
}

/** Preset params with the stored help images (C25/X15); unresolved ones are left out. */
function presetParams(
  ctx: ApplyContext,
  pp: PlannedProduct,
  pr: PlannedPreset,
): Record<string, unknown> {
  const help = pp.mapped.help_images?.[pr.descriptor.source_ref];
  if (!help) return pr.descriptor.params;
  const urls: Record<string, string> = {};
  for (const [k, img] of Object.entries(help)) {
    const url = publicUrlOf(ctx, img.source_url);
    if (url) urls[k] = url;
  }
  return Object.keys(urls).length
    ? { ...pr.descriptor.params, help_images: urls }
    : pr.descriptor.params;
}

/** One product: rows + presets + fallback fields + ledger + items, in one transaction. */
async function applyOne(
  ctx: ApplyContext,
  pp: PlannedProduct,
  lookups: ProductLookups,
): Promise<void> {
  const m = pp.mapped;
  await ctx.prisma.$transaction(
    async (tx) => {
      const items: ApplyItem[] = [];
      const writes = pp.action === 'CREATE' || pp.action === 'UPDATE';
      let productId = pp.target_id;
      let result: WriteResult | null = null;
      if (writes) {
        result = await writeProductRows(tx, ctx, pp, lookups);
        productId = result.productId;
      }
      items.push({
        entity_type: 'PRODUCT',
        external_ref: m.ref,
        action: pp.action,
        target_id: productId,
        message: pp.skip_reason,
        title: m.translation.title,
        ...(result?.before
          ? { before: result.before as unknown as Prisma.InputJsonValue }
          : {}),
      });
      for (const v of pp.variants)
        items.push({
          entity_type: 'VARIANT',
          external_ref: v.mapped.ref,
          action: v.action,
          target_id: v.target_id,
        });
      for (const d of pp.deactivate)
        items.push({
          entity_type: 'VARIANT',
          external_ref: d.external_ref,
          action: 'UPDATE',
          target_id: d.id,
          message: 'deactivated (removed from the source)',
        });

      // Personalization presets (M4.1, C25) inside this transaction.
      const toApply: PresetRequest[] = [];
      const presetByRef = new Map(
        pp.presets.map((x) => [x.descriptor.source_ref, x]),
      );
      for (const pr of pp.presets) {
        if ((pr.action === 'CREATE' || pr.action === 'UPDATE') && productId) {
          toApply.push({
            key: pr.descriptor.key,
            params: presetParams(ctx, pp, pr),
            source_ref: pr.descriptor.source_ref,
            mode: pr.mode,
          });
        } else if (pr.action === 'STAGE') {
          await upsertLedger(tx, ctx, {
            entity_type: 'PERSONALIZATION',
            external_ref: pr.descriptor.source_ref,
            target_id: productId,
            source_hash: pr.source_hash,
            created: true,
            status: ImportEntityStatus.STAGED,
            payload: {
              key: pr.descriptor.key,
              params: pr.descriptor.params as Prisma.InputJsonValue,
              product_ref: m.ref,
            },
          });
        }
        items.push({
          entity_type: 'PERSONALIZATION',
          external_ref: pr.descriptor.source_ref,
          action: pr.action,
          target_id: productId,
        });
      }
      for (const b of m.broken_presets)
        items.push({
          entity_type: 'PERSONALIZATION',
          external_ref: b.source_ref,
          action: 'SKIP',
          target_id: productId,
          message: 'W_PERSONALIZATION_BROKEN_CONFIG',
        });
      if (toApply.length && productId) {
        const results = await ctx.personalization.applyPresets(
          tx,
          productId,
          toApply,
        );
        for (const r of results) {
          const pr = presetByRef.get(r.source_ref)!;
          await upsertLedger(tx, ctx, {
            entity_type: 'PERSONALIZATION',
            external_ref: r.source_ref,
            target_id: productId,
            source_hash: pr.source_hash,
            // Only fields this call made belong to the run (rollback deletes them).
            created: pr.action === 'CREATE' && r.field_ids.length > 0,
            payload: { field_ids: r.field_ids, skipped: r.skipped },
          });
        }
      }

      // NPP fallback fields (D28).
      if (pp.fallback && productId) {
        if (pp.fallback.action === 'CREATE') {
          const created = await writeFallbackFields(
            tx,
            ctx,
            productId,
            pp.fallback.ref,
          );
          await upsertLedger(tx, ctx, {
            entity_type: 'FALLBACK_FIELD',
            external_ref: pp.fallback.ref,
            target_id: productId,
            source_hash: pp.source_hash,
            // Fix 15: fields that were already there are not this run's.
            created,
            created_by_import: created,
          });
        }
        items.push({
          entity_type: 'FALLBACK_FIELD',
          external_ref: pp.fallback.ref,
          action: pp.fallback.action,
          target_id: productId,
        });
      }

      // Ledger: applied hash = the managed fields as they are now.
      if (writes && productId) {
        const rows = (
          await loadProductStateRows(tx, [productId], ctx.primaryLocale)
        ).get(productId)!;
        await upsertLedger(tx, ctx, {
          entity_type: 'PRODUCT',
          external_ref: m.ref,
          target_id: productId,
          source_hash: pp.source_hash,
          applied_hash: productStateHash(rows),
          created: pp.action === 'CREATE',
          created_by_import: pp.created_by_import,
          payload: result?.incomplete
            ? ({
                incomplete: result.incomplete,
              } as unknown as Prisma.InputJsonValue)
            : null,
        });
        for (const v of pp.variants) {
          if (v.action !== 'CREATE' && v.action !== 'UPDATE') continue;
          await upsertLedger(tx, ctx, {
            entity_type: 'VARIANT',
            external_ref: v.mapped.ref,
            target_id: v.target_id,
            source_hash: v.source_hash,
            created: v.action === 'CREATE',
            created_by_import: v.created_by_import,
          });
        }
      }
      await recordItems(tx, ctx.runId, ImportItemPhase.APPLY, items);
      // M5 B10: the claim is re-checked inside the transaction so a worker
      // that lost the run commits nothing.
      await ctx.assertClaim(tx);
    },
    { timeout: PRODUCT_TX_TIMEOUT_MS, maxWait: 10_000 },
  );
}

/** True for the engine's own "stop now" errors (never counted as a product error). */
function isRunControlError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return (
    code === 'IMPORT_RUN_INTERRUPTED' ||
    code === 'IMPORT_RUN_CANCELLED' ||
    code === 'IMPORT_RUN_TIMEOUT'
  );
}

/** Products phase: one transaction per product, checkpoint every 25. */
export async function applyProducts(
  ctx: ApplyContext,
  planned: PlannedProduct[],
  start: number,
  onBatch: (next: number) => Promise<void>,
): Promise<{ errors: number }> {
  let errors = 0;
  const lookups = await loadProductLookups(ctx);
  for (let i = start; i < planned.length; i += PRODUCT_BATCH) {
    await ctx.checkpoint();
    const batch = planned.slice(i, i + PRODUCT_BATCH);
    const done = await appliedRefs(
      ctx.prisma,
      ctx.runId,
      'PRODUCT',
      batch.map((p) => p.mapped.ref),
    );
    for (const pp of batch) {
      if (done.has(pp.mapped.ref)) continue;
      // M5 B10: a taken-over worker stops before the next product transaction.
      await ctx.assertClaim(ctx.prisma);
      try {
        await applyOne(ctx, pp, lookups);
      } catch (err) {
        if (isRunControlError(err)) throw err;
        errors++;
        await ctx.log(
          ImportLogLevel.ERROR,
          'IMPORT_PRODUCT_FAILED',
          errorMessage(err),
          {
            entity_type: 'PRODUCT',
            external_ref: pp.mapped.ref,
          },
        );
        await recordItems(ctx.prisma, ctx.runId, ImportItemPhase.APPLY, [
          {
            entity_type: 'PRODUCT',
            external_ref: pp.mapped.ref,
            action: 'ERROR',
            target_id: pp.target_id,
            message: errorMessage(err),
          },
        ]);
      }
    }
    await onBatch(Math.min(i + PRODUCT_BATCH, planned.length));
  }
  return { errors };
}

/** D6 `on_source_removed`: draft or archive products that left the source. */
export async function applyRemovals(
  ctx: ApplyContext,
  removals: PlannedRemoval[],
): Promise<void> {
  if (!removals.length) return;
  const done = await appliedRefs(
    ctx.prisma,
    ctx.runId,
    'PRODUCT',
    removals.map((r) => r.ref),
  );
  for (const r of removals) {
    if (done.has(r.ref)) continue;
    await ctx.prisma.$transaction(async (tx) => {
      const cur = await tx.product.findUnique({
        where: { id: r.target_id },
        select: { status: true },
      });
      await tx.product.update({
        where: { id: r.target_id },
        data: { status: r.to_status as ProductStatus },
      });
      await recordItems(tx, ctx.runId, ImportItemPhase.APPLY, [
        {
          entity_type: 'PRODUCT',
          external_ref: r.ref,
          action: 'UPDATE',
          target_id: r.target_id,
          message: `source removed → ${r.to_status}`,
          // Rollback puts the status back (fix 6).
          ...(cur ? { before: { status_only: cur.status } } : {}),
        },
      ]);
    });
  }
}

/** Products skipped by rule (U4 skip list, drafts excluded): recorded as SKIP. */
export async function applySkipped(
  ctx: ApplyContext,
  skipped: { ref: string; target_id: string | null; title: string }[],
): Promise<void> {
  if (!skipped.length) return;
  const done = await appliedRefs(
    ctx.prisma,
    ctx.runId,
    'PRODUCT',
    skipped.map((s) => s.ref),
  );
  await recordItems(
    ctx.prisma,
    ctx.runId,
    ImportItemPhase.APPLY,
    skipped
      .filter((s) => !done.has(s.ref))
      .map((s) => ({
        entity_type: 'PRODUCT',
        external_ref: s.ref,
        action: 'SKIP',
        target_id: s.target_id,
        message: 'W_PRODUCT_SKIPPED_BY_RULE',
        title: s.title,
      })),
  );
}
