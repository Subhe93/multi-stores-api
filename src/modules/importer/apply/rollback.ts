import {
  CustomizationType,
  ImportEntityStatus,
  ImportItemAction,
  ImportItemPhase,
  Prisma,
  ProductStatus,
  ProductType,
  RedirectSource,
  type ImportEntity,
  type PrismaClient,
} from '@prisma/client';
import type { PrivateStorage } from '../../../common/storage/private-file-storage';
import type {
  DesignerImportPort,
  DesignerTemplateRollback,
} from '../../../common/ports/designer-import.port';
import { categoryStateHash, productStateHash } from '../mapping/state';
import { loadProductStateRows, SNAPSHOT_PAGE } from '../planner/state-loader';
import { errorMessage, recordItems, type ApplyItem } from './apply-context';
import { NPP_FALLBACK_PRESET_KEY, type ProductBefore } from './apply-products';
import {
  parseCategoryBefore,
  parseProductBefore,
  parseRedirectBefore,
  parseStatusOnlyBefore,
} from './rollback-before';

/**
 * Soft rollback of one run (M4.4 D7, §9.4), in reverse dependency order:
 *  1. redirects: rows the run created are deleted; rows it updated or
 *     re-pointed get their `before` back (fix 5);
 *  2. preset and fallback fields (M4.0 SetNull keeps order snapshots, X37);
 *  3. products the run created: deleted without `OrderItem` rows, else
 *     ARCHIVED; edited by the merchant since → ARCHIVED and reported
 *     (`archived_edited`, fix 6). Variants the run added to other products
 *     are deleted or deactivated. Products the run UPDATED get their `before`
 *     back unless edited since (`skipped_edited`);
 *  4. collections the run created, unless a product outside the run is
 *     linked or the merchant edited them (`skipped_edited`); updated /
 *     adopted collections get their `before` back;
 *  5. shipping: keep/delete is decided per profile; zones and methods go only
 *     with a deleted profile; the creator's only (default) profile is kept;
 *  6. media files no longer referenced anywhere (images, thumbnails, option
 *     configs, help images, inline `<img>` in descriptions and FAQs).
 * Ledger rows → ROLLED_BACK so a re-run creates them again. Idempotent: a
 * retried rollback skips rows that are already rolled back.
 *
 * M5 B11: every product step is wrapped per product (a RESTRICT relation or
 * any other failure becomes an ERROR item and the rollback goes on), and
 * ROLLBACK items are recorded after every step, so a crash keeps the items
 * of the finished part. M5 B18: one function per step.
 */

export interface RollbackDeps {
  prisma: PrismaClient;
  storage: PrivateStorage;
  uploads: { deleteFile(url: string): Promise<void> };
  redirects: { invalidate(storeId: string): void };
  storeId: string;
  creatorId: string;
  runId: string;
  /** Store primary locale (translations of restored rows). */
  primaryLocale?: string;
  /** Heartbeat between steps (fix 21); throws when the run was taken over. */
  checkpoint?: () => Promise<void>;
  /** M4.2 WP7: removes the designer templates the run handed off. */
  designer?: Pick<DesignerImportPort, 'rollbackTemplates'>;
}

export interface RollbackEditedEntry {
  entity_type: string;
  external_ref: string;
  target_id: string | null;
  title: string | null;
}

export interface RollbackResult {
  redirects: number;
  redirects_restored: number;
  fields: number;
  products_deleted: number;
  products_archived: number;
  products_restored: number;
  variants_deleted: number;
  variants_deactivated: number;
  categories_deleted: number;
  categories_kept: number;
  categories_restored: number;
  shipping_deleted: number;
  shipping_kept: number;
  media_deleted: number;
  templates: number;
  /** M5 B17: draft builder pages the run created, deleted again. */
  pages_deleted: number;
  /** Imported pages the merchant published since: kept. */
  pages_kept: number;
  errors: number;
  /** Created by the run, edited by the merchant since: archived, not deleted. */
  archived_edited: RollbackEditedEntry[];
  /** Edited by the merchant since the run: left as they are. */
  skipped_edited: RollbackEditedEntry[];
}

const CHUNK = SNAPSHOT_PAGE;
const BEAT_EVERY = 25;
/** Items recorded at least this often inside long steps (M5 B11). */
const FLUSH_EVERY = 100;

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

const titleOf = (d: unknown): string | null =>
  d &&
  typeof d === 'object' &&
  typeof (d as { title?: unknown }).title === 'string'
    ? (d as { title: string }).title
    : null;

interface UpdatedItem {
  entity_type: string;
  external_ref: string;
  target_id: string | null;
  before: Prisma.JsonValue | null;
  diff: Prisma.JsonValue | null;
}

/** Shared state of one rollback (M5 B18). */
interface RollbackState {
  deps: RollbackDeps;
  prisma: PrismaClient;
  storeId: string;
  runId: string;
  locale: string;
  out: RollbackResult;
  /** Items not yet written; `flush()` records and clears them. */
  items: ApplyItem[];
  /** Ledger rows the run created (not yet rolled back), by entity type. */
  ofType(type: string): ImportEntity[];
  /** APPLY items of the run with a `before` image, of one type. */
  updatedOf(type: string): UpdatedItem[];
  /** Products the run created (ids), for the "outside the run" checks. */
  runProductIds: Set<string>;
  beat(force?: boolean): Promise<void>;
  flush(): Promise<void>;
  markRolledBack(ids: string[]): Promise<void>;
  ledgerRow(type: string, ref: string): Promise<ImportEntity | null>;
  productHash(id: string): Promise<string | null>;
}

export async function rollbackRun(deps: RollbackDeps): Promise<RollbackResult> {
  const s = await loadRollbackState(deps);
  await rollbackRedirects(s);
  await rollbackFields(s);
  await rollbackCreatedProducts(s);
  await rollbackCreatedVariants(s);
  await rollbackUpdatedProducts(s);
  await rollbackCreatedCategories(s);
  await rollbackUpdatedCategories(s);
  await rollbackShipping(s);
  await rollbackTemplates(s);
  await rollbackPages(s);
  await s.beat(true);
  // 6. Media of the run that nothing references any more (batched, fix 14 / M5 B14).
  s.out.media_deleted = await rollbackMedia(deps, s.items);
  await s.flush();
  await fillEditedTitles(s);
  return s.out;
}

async function loadRollbackState(deps: RollbackDeps): Promise<RollbackState> {
  const { prisma, storeId, runId } = deps;
  const locale = deps.primaryLocale ?? 'en';
  const out: RollbackResult = {
    redirects: 0,
    redirects_restored: 0,
    fields: 0,
    products_deleted: 0,
    products_archived: 0,
    products_restored: 0,
    variants_deleted: 0,
    variants_deactivated: 0,
    categories_deleted: 0,
    categories_kept: 0,
    categories_restored: 0,
    shipping_deleted: 0,
    shipping_kept: 0,
    media_deleted: 0,
    templates: 0,
    pages_deleted: 0,
    pages_kept: 0,
    errors: 0,
    archived_edited: [],
    skipped_edited: [],
  };
  const items: ApplyItem[] = [];
  let beats = 0;
  const created = await prisma.importEntity.findMany({
    where: {
      store_id: storeId,
      first_run_id: runId,
      created_by_import: true,
      status: { not: ImportEntityStatus.ROLLED_BACK },
    },
  });
  const byType = new Map<string, ImportEntity[]>();
  for (const e of created) {
    const list = byType.get(e.entity_type) ?? [];
    list.push(e);
    byType.set(e.entity_type, list);
  }
  // APPLY items of the run that carry a `before` image (UPDATE / adopt).
  const updatedItems = await prisma.importRunItem.findMany({
    where: {
      run_id: runId,
      phase: ImportItemPhase.APPLY,
      action: ImportItemAction.UPDATE,
      before: { not: Prisma.DbNull },
    },
    select: {
      entity_type: true,
      external_ref: true,
      target_id: true,
      before: true,
      diff: true,
    },
  });
  const runProducts = (byType.get('PRODUCT') ?? []).filter((e) => e.target_id);
  return {
    deps,
    prisma,
    storeId,
    runId,
    locale,
    out,
    items,
    ofType: (t) => byType.get(t) ?? [],
    updatedOf: (t) =>
      updatedItems.filter(
        (i) => i.entity_type === t && i.before !== null && i.target_id,
      ),
    runProductIds: new Set(runProducts.map((e) => e.target_id!)),
    beat: async (force = false) => {
      if (deps.checkpoint && (force || ++beats % BEAT_EVERY === 0))
        await deps.checkpoint();
    },
    flush: async () => {
      if (!items.length) return;
      const batch = items.splice(0);
      await recordItems(prisma, runId, ImportItemPhase.ROLLBACK, batch);
    },
    markRolledBack: async (ids) => {
      for (const part of chunks(ids))
        if (part.length)
          await prisma.importEntity.updateMany({
            where: { id: { in: part } },
            data: {
              status: ImportEntityStatus.ROLLED_BACK,
              last_run_id: runId,
            },
          });
    },
    ledgerRow: (type, ref) =>
      prisma.importEntity.findUnique({
        where: {
          store_id_entity_type_external_ref: {
            store_id: storeId,
            entity_type: type,
            external_ref: ref,
          },
        },
      }),
    productHash: async (id) => {
      const rows = (await loadProductStateRows(prisma, [id], locale)).get(id);
      return rows ? productStateHash(rows) : null;
    },
  };
}

/** A failure of one entity: counted, recorded, never fatal (M5 B11). */
function recordError(
  s: RollbackState,
  entityType: string,
  ref: string,
  targetId: string | null,
  err: unknown,
): void {
  s.out.errors++;
  s.items.push({
    entity_type: entityType,
    external_ref: ref,
    action: 'ERROR',
    target_id: targetId,
    message: errorMessage(err),
  });
}

// 1. Redirects: created rows deleted, updated / re-pointed rows restored.
async function rollbackRedirects(s: RollbackState): Promise<void> {
  const { prisma, storeId, runId, out, items } = s;
  const red = await prisma.storeRedirect.findMany({
    where: {
      store_id: storeId,
      import_run_id: runId,
      source: RedirectSource.IMPORT,
    },
    select: { id: true, from_path: true },
  });
  for (const part of chunks(red.map((r) => r.id)))
    await prisma.storeRedirect.deleteMany({ where: { id: { in: part } } });
  for (const r of red)
    items.push({
      entity_type: 'REDIRECT',
      external_ref: r.from_path,
      action: 'DELETE',
      target_id: r.id,
    });
  out.redirects = red.length;
  for (const it of s.updatedOf('REDIRECT')) {
    const before = parseRedirectBefore(it.before);
    const wrote = titleless(it.diff)?.to_path;
    const cur = await prisma.storeRedirect.findUnique({
      where: { id: it.target_id! },
      select: { to_path: true, source: true },
    });
    // Only when nothing changed the row since this run wrote it.
    if (
      !before ||
      !cur ||
      cur.source !== RedirectSource.IMPORT ||
      (wrote && cur.to_path !== wrote)
    ) {
      items.push({
        entity_type: 'REDIRECT',
        external_ref: it.external_ref,
        action: 'SKIP',
        target_id: it.target_id,
        message: before ? 'changed since the run' : 'invalid before image',
      });
      continue;
    }
    await prisma.storeRedirect.update({
      where: { id: it.target_id! },
      data: {
        to_path: before.to_path,
        status_code: before.status_code,
        is_active: before.is_active,
      },
    });
    out.redirects_restored++;
    items.push({
      entity_type: 'REDIRECT',
      external_ref: it.external_ref,
      action: 'UPDATE',
      target_id: it.target_id,
      message: 'restored',
    });
  }
  if (red.length || out.redirects_restored)
    s.deps.redirects.invalidate(storeId);
  await s.flush();
  await s.beat(true);
}

/** `diff.to_path` of a redirect item (what the run wrote). */
function titleless(diff: Prisma.JsonValue | null): { to_path?: string } | null {
  if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return null;
  const to = (diff as { to_path?: unknown }).to_path;
  return typeof to === 'string' ? { to_path: to } : {};
}

// 2. Preset and fallback fields.
async function rollbackFields(s: RollbackState): Promise<void> {
  const { prisma, out, items } = s;
  const rows = [...s.ofType('PERSONALIZATION'), ...s.ofType('FALLBACK_FIELD')];
  for (const e of rows) {
    if (e.status === ImportEntityStatus.ACTIVE && e.target_id) {
      const where =
        e.entity_type === 'FALLBACK_FIELD'
          ? {
              product_id: e.target_id,
              preset_key: NPP_FALLBACK_PRESET_KEY,
              parent_id: null,
            }
          : {
              product_id: e.target_id,
              preset_ref: e.external_ref.slice(0, 191),
              parent_id: null,
            };
      try {
        const res = await prisma.productCustomField.deleteMany({ where });
        out.fields += res.count;
        items.push({
          entity_type: e.entity_type,
          external_ref: e.external_ref,
          action: 'DELETE',
          target_id: e.target_id,
        });
      } catch (err) {
        recordError(s, e.entity_type, e.external_ref, e.target_id, err);
      }
    } else {
      items.push({
        entity_type: e.entity_type,
        external_ref: e.external_ref,
        action: 'DELETE',
        target_id: e.target_id,
        message: 'staged',
      });
    }
    await s.beat();
    if (items.length >= FLUSH_EVERY) await s.flush();
  }
  await s.markRolledBack(rows.map((e) => e.id));
  await s.flush();
}

// 3. Products created by the run.
async function rollbackCreatedProducts(s: RollbackState): Promise<void> {
  const { prisma, out, items } = s;
  const runProducts = s.ofType('PRODUCT').filter((e) => e.target_id);
  const done: string[] = [];
  for (const e of runProducts) {
    await s.beat();
    const id = e.target_id!;
    try {
      const exists = await prisma.product.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!exists) {
        done.push(e.id);
        continue;
      }
      const edited =
        !!e.applied_hash && (await s.productHash(id)) !== e.applied_hash;
      const orders = await prisma.orderItem.count({
        where: { product_id: id },
      });
      if (orders > 0 || edited) {
        await prisma.product.update({
          where: { id },
          data: { status: ProductStatus.ARCHIVED },
        });
        out.products_archived++;
        items.push({
          entity_type: 'PRODUCT',
          external_ref: e.external_ref,
          action: 'ARCHIVE',
          target_id: id,
          message: edited ? 'W_ROLLBACK_TARGET_MODIFIED' : 'has orders',
        });
        if (edited)
          out.archived_edited.push({
            entity_type: 'PRODUCT',
            external_ref: e.external_ref,
            target_id: id,
            title: null,
          });
      } else {
        // A RESTRICT relation (cart line, design, …) rejects the delete:
        // the product is reported and the rollback goes on (M5 B11).
        await prisma.$transaction(async (tx) => {
          await tx.productCustomField.deleteMany({ where: { product_id: id } });
          const faqs = await tx.productFaq.findMany({
            where: { product_id: id },
            select: { id: true },
          });
          if (faqs.length)
            await tx.productFaqTranslation.deleteMany({
              where: { faq_id: { in: faqs.map((f) => f.id) } },
            });
          await tx.productFaq.deleteMany({ where: { product_id: id } });
          await tx.productImage.deleteMany({ where: { product_id: id } });
          await tx.productTag.deleteMany({ where: { product_id: id } });
          await tx.productCreatorCategory.deleteMany({
            where: { product_id: id },
          });
          await tx.productVariant.deleteMany({ where: { product_id: id } });
          await tx.productTranslation.deleteMany({ where: { product_id: id } });
          await tx.product.delete({ where: { id } });
        });
        out.products_deleted++;
        items.push({
          entity_type: 'PRODUCT',
          external_ref: e.external_ref,
          action: 'DELETE',
          target_id: id,
        });
      }
      done.push(e.id);
    } catch (err) {
      recordError(s, 'PRODUCT', e.external_ref, id, err);
    }
    if (items.length >= FLUSH_EVERY) await s.flush();
  }
  await s.markRolledBack(done);
  await s.flush();
}

// 3a. Variants the run added to products it did not create.
async function rollbackCreatedVariants(s: RollbackState): Promise<void> {
  const { prisma, out, items } = s;
  const done: string[] = [];
  for (const e of s.ofType('VARIANT')) {
    if (!e.target_id) {
      done.push(e.id);
      continue;
    }
    await s.beat();
    try {
      const v = await prisma.productVariant.findUnique({
        where: { id: e.target_id },
        select: { id: true, product_id: true },
      });
      if (!v || s.runProductIds.has(v.product_id)) {
        done.push(e.id);
        continue;
      }
      const orders = await prisma.orderItem.count({
        where: { variant_id: v.id },
      });
      if (orders > 0) {
        await prisma.productVariant.update({
          where: { id: v.id },
          data: { is_active: false },
        });
        out.variants_deactivated++;
        items.push({
          entity_type: 'VARIANT',
          external_ref: e.external_ref,
          action: 'ARCHIVE',
          target_id: v.id,
          message: 'has orders',
        });
      } else {
        await prisma.productVariant.delete({ where: { id: v.id } });
        out.variants_deleted++;
        items.push({
          entity_type: 'VARIANT',
          external_ref: e.external_ref,
          action: 'DELETE',
          target_id: v.id,
        });
      }
      done.push(e.id);
    } catch (err) {
      recordError(s, 'VARIANT', e.external_ref, e.target_id, err);
    }
    if (items.length >= FLUSH_EVERY) await s.flush();
  }
  await s.markRolledBack(done);
  await s.flush();
}

// 3b. Products the run updated: their `before` comes back (D7, fix 6).
async function rollbackUpdatedProducts(s: RollbackState): Promise<void> {
  const { prisma, runId, locale, out, items } = s;
  for (const it of s.updatedOf('PRODUCT')) {
    await s.beat();
    const id = it.target_id!;
    try {
      const exists = await prisma.product.findUnique({
        where: { id },
        select: { status: true },
      });
      if (!exists) continue;
      const statusOnly = parseStatusOnlyBefore(it.before);
      if (statusOnly) {
        // on_source_removed: only the status was changed.
        await prisma.product.update({
          where: { id },
          data: { status: statusOnly },
        });
        out.products_restored++;
        items.push({
          entity_type: 'PRODUCT',
          external_ref: it.external_ref,
          action: 'UPDATE',
          target_id: id,
          message: 'restored',
        });
        continue;
      }
      const before = parseProductBefore(it.before);
      if (!before) {
        items.push({
          entity_type: 'PRODUCT',
          external_ref: it.external_ref,
          action: 'SKIP',
          target_id: id,
          message: 'invalid before image',
        });
        continue;
      }
      const ledger = await s.ledgerRow('PRODUCT', it.external_ref);
      const current = await s.productHash(id);
      if (
        !ledger ||
        ledger.last_run_id !== runId ||
        !ledger.applied_hash ||
        ledger.applied_hash !== current
      ) {
        out.skipped_edited.push({
          entity_type: 'PRODUCT',
          external_ref: it.external_ref,
          target_id: id,
          title: titleOf(it.diff),
        });
        items.push({
          entity_type: 'PRODUCT',
          external_ref: it.external_ref,
          action: 'SKIP',
          target_id: id,
          message: 'W_ROLLBACK_TARGET_MODIFIED',
        });
        continue;
      }
      await prisma.$transaction(
        (tx) => restoreProduct(tx, id, before, locale, ledger.id),
        { timeout: 30_000 },
      );
      out.products_restored++;
      items.push({
        entity_type: 'PRODUCT',
        external_ref: it.external_ref,
        action: 'UPDATE',
        target_id: id,
        message: 'restored',
      });
    } catch (err) {
      recordError(s, 'PRODUCT', it.external_ref, id, err);
    }
    if (items.length >= FLUSH_EVERY) await s.flush();
  }
  await s.flush();
}

// 4. Collections (children before parents).
async function rollbackCreatedCategories(s: RollbackState): Promise<void> {
  const { prisma, locale, out, items } = s;
  const cats = s
    .ofType('CATEGORY')
    .filter((e) => e.target_id)
    .reverse();
  const keptCats = new Set<string>();
  for (const e of cats) {
    await s.beat();
    const id = e.target_id!;
    try {
      const exists = await prisma.creatorCategory.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!exists) continue;
      if (
        e.applied_hash &&
        (await categoryHash(prisma, id, locale)) !== e.applied_hash
      ) {
        keptCats.add(e.id);
        out.categories_kept++;
        out.skipped_edited.push({
          entity_type: 'CATEGORY',
          external_ref: e.external_ref,
          target_id: id,
          title: null,
        });
        items.push({
          entity_type: 'CATEGORY',
          external_ref: e.external_ref,
          action: 'SKIP',
          target_id: id,
          message: 'W_ROLLBACK_TARGET_MODIFIED',
        });
        continue;
      }
      const links = await prisma.productCreatorCategory.findMany({
        where: { creator_category_id: id },
        select: { product_id: true },
      });
      const foreign = links.filter((l) => !s.runProductIds.has(l.product_id));
      if (foreign.length) {
        keptCats.add(e.id);
        out.categories_kept++;
        items.push({
          entity_type: 'CATEGORY',
          external_ref: e.external_ref,
          action: 'SKIP',
          target_id: id,
          message: 'linked to products outside the run',
        });
        continue;
      }
      await prisma.$transaction(async (tx) => {
        await tx.productCreatorCategory.deleteMany({
          where: { creator_category_id: id },
        });
        await tx.creatorCategory.updateMany({
          where: { parent_id: id },
          data: { parent_id: null },
        });
        await tx.creatorCategoryTranslation.deleteMany({
          where: { creator_category_id: id },
        });
        await tx.creatorCategory.delete({ where: { id } });
      });
      out.categories_deleted++;
      items.push({
        entity_type: 'CATEGORY',
        external_ref: e.external_ref,
        action: 'DELETE',
        target_id: id,
      });
    } catch (err) {
      keptCats.add(e.id);
      recordError(s, 'CATEGORY', e.external_ref, id, err);
    }
    if (items.length >= FLUSH_EVERY) await s.flush();
  }
  await s.markRolledBack(
    cats.filter((e) => !keptCats.has(e.id)).map((e) => e.id),
  );
  await s.flush();
}

// 4b. Updated / adopted collections: prior fields back (D7, fix 6).
async function rollbackUpdatedCategories(s: RollbackState): Promise<void> {
  const { prisma, runId, locale, out, items } = s;
  for (const it of s.updatedOf('CATEGORY')) {
    await s.beat();
    const id = it.target_id!;
    try {
      const before = parseCategoryBefore(it.before);
      const exists = await prisma.creatorCategory.findUnique({
        where: { id },
        select: { id: true },
      });
      if (!exists) continue;
      if (!before) {
        items.push({
          entity_type: 'CATEGORY',
          external_ref: it.external_ref,
          action: 'SKIP',
          target_id: id,
          message: 'invalid before image',
        });
        continue;
      }
      const ledger = await s.ledgerRow('CATEGORY', it.external_ref);
      const current = await categoryHash(prisma, id, locale);
      if (
        !ledger ||
        ledger.last_run_id !== runId ||
        !ledger.applied_hash ||
        ledger.applied_hash !== current
      ) {
        out.skipped_edited.push({
          entity_type: 'CATEGORY',
          external_ref: it.external_ref,
          target_id: id,
          title: titleOf(it.diff),
        });
        items.push({
          entity_type: 'CATEGORY',
          external_ref: it.external_ref,
          action: 'SKIP',
          target_id: id,
          message: 'W_ROLLBACK_TARGET_MODIFIED',
        });
        continue;
      }
      await prisma.$transaction(async (tx) => {
        const parentOk =
          !before.category.parent_id ||
          !!(await tx.creatorCategory.findUnique({
            where: { id: before.category.parent_id },
            select: { id: true },
          }));
        await tx.creatorCategory.update({
          where: { id },
          data: {
            ...before.category,
            parent_id: parentOk ? before.category.parent_id : null,
          },
        });
        if (before.translation)
          await tx.creatorCategoryTranslation.upsert({
            where: {
              creator_category_id_locale: { creator_category_id: id, locale },
            },
            create: { ...before.translation, creator_category_id: id, locale },
            update: before.translation,
          });
        await restoreLedger(tx, ledger.id, before.ledger);
      });
      out.categories_restored++;
      items.push({
        entity_type: 'CATEGORY',
        external_ref: it.external_ref,
        action: 'UPDATE',
        target_id: id,
        message: 'restored',
      });
    } catch (err) {
      recordError(s, 'CATEGORY', it.external_ref, id, err);
    }
    if (items.length >= FLUSH_EVERY) await s.flush();
  }
  await s.flush();
}

// 5. Shipping: keep / delete per profile; zones and methods only with it.
async function rollbackShipping(s: RollbackState): Promise<void> {
  const { prisma, deps, out, items } = s;
  const deletedProfiles = new Set<string>();
  for (const e of s.ofType('SHIPPING_PROFILE')) {
    if (!e.target_id) continue;
    await s.beat();
    try {
      const prof = await prisma.shippingProfile.findUnique({
        where: { id: e.target_id },
        select: { id: true, is_default: true },
      });
      if (!prof) {
        deletedProfiles.add(e.target_id);
        await s.markRolledBack([e.id]);
        continue;
      }
      const users = await prisma.product.findMany({
        where: { shipping_profile_id: prof.id },
        select: { id: true },
      });
      const foreignUsers = users.filter((u) => !s.runProductIds.has(u.id));
      const otherProfiles = await prisma.shippingProfile.count({
        where: { creator_id: deps.creatorId, id: { not: prof.id } },
      });
      // The creator's only (default) profile is never deleted (fix 4).
      if (foreignUsers.length || (prof.is_default && otherProfiles === 0)) {
        out.shipping_kept++;
        items.push({
          entity_type: 'SHIPPING_PROFILE',
          external_ref: e.external_ref,
          action: 'SKIP',
          target_id: prof.id,
          message: foreignUsers.length
            ? 'still in use'
            : 'only default profile',
        });
        continue;
      }
      await prisma.$transaction(async (tx) => {
        await tx.product.updateMany({
          where: { shipping_profile_id: prof.id },
          data: { shipping_profile_id: null },
        });
        const zones = await tx.shippingZone.findMany({
          where: { profile_id: prof.id },
          select: { id: true },
        });
        if (zones.length)
          await tx.shippingMethod.deleteMany({
            where: { zone_id: { in: zones.map((z) => z.id) } },
          });
        await tx.shippingZone.deleteMany({ where: { profile_id: prof.id } });
        await tx.shippingProfile.delete({ where: { id: prof.id } });
      });
      deletedProfiles.add(prof.id);
      out.shipping_deleted++;
      await s.markRolledBack([e.id]);
      items.push({
        entity_type: 'SHIPPING_PROFILE',
        external_ref: e.external_ref,
        action: 'DELETE',
        target_id: prof.id,
      });
    } catch (err) {
      recordError(s, 'SHIPPING_PROFILE', e.external_ref, e.target_id, err);
    }
  }
  // Zones / methods the run created: gone with their profile, else kept.
  const zoneProfile = new Map<string, string | null>();
  for (const e of s.ofType('SHIPPING_ZONE')) {
    if (!e.target_id) continue;
    const z = await prisma.shippingZone.findUnique({
      where: { id: e.target_id },
      select: { profile_id: true },
    });
    zoneProfile.set(e.target_id, z?.profile_id ?? null);
  }
  for (const type of ['SHIPPING_ZONE', 'SHIPPING_METHOD'] as const) {
    const gone: string[] = [];
    for (const e of s.ofType(type)) {
      if (!e.target_id) continue;
      let exists: boolean;
      if (type === 'SHIPPING_ZONE')
        exists = zoneProfile.get(e.target_id) !== null;
      else
        exists = !!(await prisma.shippingMethod.findUnique({
          where: { id: e.target_id },
          select: { id: true },
        }));
      if (!exists) {
        gone.push(e.id);
        items.push({
          entity_type: type,
          external_ref: e.external_ref,
          action: 'DELETE',
          target_id: e.target_id,
          message: 'with its profile',
        });
      } else {
        items.push({
          entity_type: type,
          external_ref: e.external_ref,
          action: 'SKIP',
          target_id: e.target_id,
          message: 'profile kept',
        });
      }
    }
    await s.markRolledBack(gone);
  }
  await s.flush();
}

// Staged / handed-off templates. Handed-off ones are deleted by the
// designer (M4.2 WP7) unless orders/designs use them or they were edited.
async function rollbackTemplates(s: RollbackState): Promise<void> {
  const { prisma, deps, storeId, runId, out, items } = s;
  const handedOff = s
    .ofType('DESIGN_TEMPLATE')
    .filter((e) => e.status !== ImportEntityStatus.STAGED && e.target_id);
  const designerOutcome = new Map<string, DesignerTemplateRollback>();
  if (handedOff.length && deps.designer?.rollbackTemplates) {
    try {
      const run = await prisma.importRun.findUnique({
        where: { id: runId },
        select: { created_at: true },
      });
      const res = await deps.designer.rollbackTemplates(
        storeId,
        handedOff.map((e) => e.target_id!),
        { created_since: run?.created_at },
      );
      for (const r of res) designerOutcome.set(r.template_id, r);
    } catch (err) {
      recordError(s, 'DESIGN_TEMPLATE', '*', null, err);
    }
  }
  for (const e of s.ofType('DESIGN_TEMPLATE')) {
    out.templates++;
    const o = e.target_id ? designerOutcome.get(e.target_id) : undefined;
    items.push({
      entity_type: 'DESIGN_TEMPLATE',
      external_ref: e.external_ref,
      action: o?.action === 'KEEP' ? 'SKIP' : 'DELETE',
      target_id: e.target_id,
      message:
        e.status === ImportEntityStatus.STAGED
          ? 'staged'
          : o
            ? o.action === 'KEEP'
              ? `designer keeps it (${o.reason ?? 'unavailable'})`
              : `deleted by the designer (${o.links_deleted} links, ${o.assets_deleted} files)`
            : 'designer keeps its copy',
    });
  }
  await s.markRolledBack(s.ofType('DESIGN_TEMPLATE').map((e) => e.id));
  await s.flush();
}

// M5 B17: imported pages. Only pages that are still unpublished drafts are
// deleted (a page the merchant published since the run is kept); the
// ledger row goes ROLLED_BACK either way, so the next run plans CREATE.
async function rollbackPages(s: RollbackState): Promise<void> {
  const { prisma, storeId, out, items } = s;
  const rows = s.ofType('PAGE');
  for (const e of rows) {
    await s.beat();
    try {
      const page = e.target_id
        ? await prisma.page.findFirst({
            where: { id: e.target_id, store_id: storeId },
            select: { id: true, status: true, published_version_id: true },
          })
        : null;
      if (!page) {
        items.push({
          entity_type: 'PAGE',
          external_ref: e.external_ref,
          action: 'SKIP',
          target_id: e.target_id,
          message: 'already gone',
        });
        continue;
      }
      if (page.status !== 'DRAFT' || page.published_version_id) {
        out.pages_kept++;
        out.skipped_edited.push({
          entity_type: 'PAGE',
          external_ref: e.external_ref,
          target_id: page.id,
          title: null,
        });
        items.push({
          entity_type: 'PAGE',
          external_ref: e.external_ref,
          action: 'SKIP',
          target_id: page.id,
          message: 'published since the import',
        });
        continue;
      }
      await prisma.page.delete({ where: { id: page.id } });
      out.pages_deleted++;
      items.push({
        entity_type: 'PAGE',
        external_ref: e.external_ref,
        action: 'DELETE',
        target_id: page.id,
      });
    } catch (err) {
      recordError(s, 'PAGE', e.external_ref, e.target_id, err);
    }
  }
  await s.markRolledBack(rows.map((e) => e.id));
  await s.flush();
}

/** Titles for the dashboard list of edited entities (from the run's items). */
async function fillEditedTitles(s: RollbackState): Promise<void> {
  const { prisma, runId, out } = s;
  const untitled = [...out.archived_edited, ...out.skipped_edited].filter(
    (x) => !x.title,
  );
  for (const part of chunks(
    untitled.map((x) => x.external_ref.slice(0, 255)),
  )) {
    const rows = await prisma.importRunItem.findMany({
      where: { run_id: runId, external_ref: { in: part } },
      select: { entity_type: true, external_ref: true, diff: true },
    });
    const titles = new Map<string, string>();
    for (const r of rows) {
      const t = titleOf(r.diff);
      if (t) titles.set(`${r.entity_type}|${r.external_ref}`, t);
    }
    for (const x of untitled)
      x.title = titles.get(`${x.entity_type}|${x.external_ref}`) ?? x.title;
  }
}

async function categoryHash(
  db: PrismaClient,
  id: string,
  locale: string,
): Promise<string | null> {
  const c = await db.creatorCategory.findUnique({
    where: { id },
    select: {
      slug: true,
      parent_id: true,
      sort_order: true,
      is_active: true,
      noindex_when_empty: true,
      thumbnail_url: true,
    },
  });
  if (!c) return null;
  const t = await db.creatorCategoryTranslation.findUnique({
    where: { creator_category_id_locale: { creator_category_id: id, locale } },
    select: {
      name: true,
      description: true,
      meta_title: true,
      meta_desc: true,
    },
  });
  return categoryStateHash({ category: c, translation: t ?? null });
}

type Tx = Prisma.TransactionClient;

async function restoreLedger(
  tx: Tx,
  ledgerId: string,
  before: ProductBefore['ledger'],
): Promise<void> {
  if (!before) {
    await tx.importEntity.update({
      where: { id: ledgerId },
      data: { status: ImportEntityStatus.ROLLED_BACK },
    });
    return;
  }
  await tx.importEntity.update({
    where: { id: ledgerId },
    data: {
      source_hash: before.source_hash,
      applied_hash: before.applied_hash,
      status: before.status,
      created_by_import: before.created_by_import,
      first_run_id: before.first_run_id,
      last_run_id: before.last_run_id,
      target_id: before.target_id,
    },
  });
}

/** Enum members of the `before` image, checked instead of cast (M5 B18). */
function enumOf<T extends string>(
  values: readonly T[],
  value: unknown,
  what: string,
): T {
  if (
    typeof value === 'string' &&
    (values as readonly string[]).includes(value)
  )
    return value as T;
  throw new Error(`before image: invalid ${what} ${JSON.stringify(value)}`);
}

/** A Decimal column value as stored in the `before` JSON (string / number). */
function decimalOf(value: unknown, what: string): string {
  if (typeof value === 'string' && value !== '') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  throw new Error(`before image: invalid ${what} ${JSON.stringify(value)}`);
}

function optionalDecimalOf(value: unknown, what: string): string | null {
  return value === null || value === undefined ? null : decimalOf(value, what);
}

/** Writes a product's managed rows back to their `before` image. */
async function restoreProduct(
  tx: Tx,
  id: string,
  before: ProductBefore,
  locale: string,
  ledgerId: string,
): Promise<void> {
  const s = before.state;
  const p = s.product;
  await tx.product.update({
    where: { id },
    data: {
      status: enumOf(Object.values(ProductStatus), p.status, 'status'),
      product_type: enumOf(
        Object.values(ProductType),
        p.product_type,
        'product_type',
      ),
      customization_type:
        p.customization_type === null || p.customization_type === undefined
          ? null
          : enumOf(
              Object.values(CustomizationType),
              p.customization_type,
              'customization_type',
            ),
      base_price: decimalOf(p.base_price, 'base_price'),
      compare_at_price: optionalDecimalOf(
        p.compare_at_price,
        'compare_at_price',
      ),
      sku: p.sku,
      track_inventory: p.track_inventory,
      weight: optionalDecimalOf(p.weight, 'weight'),
      ...(before.weight_unit ? { weight_unit: before.weight_unit } : {}),
      tax_exempt: p.tax_exempt,
      category_id: p.category_id,
      variant_option_config:
        p.variant_option_config === null ||
        p.variant_option_config === undefined
          ? Prisma.DbNull
          : (p.variant_option_config as Prisma.InputJsonValue),
      shipping_profile_id: p.shipping_profile_id,
    },
  });
  if (s.translation)
    await tx.productTranslation.upsert({
      where: { product_id_locale: { product_id: id, locale } },
      create: { ...s.translation, product_id: id, locale },
      update: s.translation,
    });
  for (const v of s.variants) {
    const exists = await tx.productVariant.findUnique({
      where: { id: v.id },
      select: { id: true },
    });
    if (!exists) continue;
    await tx.productVariant.update({
      where: { id: v.id },
      data: {
        sku: v.sku,
        price_adjustment: decimalOf(v.price_adjustment, 'price_adjustment'),
        compare_at_price: optionalDecimalOf(
          v.compare_at_price,
          'compare_at_price',
        ),
        is_active: v.is_active,
        options: (v.options ?? {}) as Prisma.InputJsonValue,
      },
    });
  }
  await tx.productImage.deleteMany({
    where: { product_id: id, variant_id: null },
  });
  const images = s.images.filter((i) => !i.variant_id);
  if (images.length)
    await tx.productImage.createMany({
      data: images.map((i) => ({
        product_id: id,
        url: i.url,
        alt_text: i.alt_text,
        sort_order: i.sort_order,
        is_featured: i.is_featured,
      })),
    });
  await tx.productTag.deleteMany({ where: { product_id: id } });
  if (s.tags.length)
    await tx.productTag.createMany({
      data: s.tags.map((t) => ({ product_id: id, tag: t.tag })),
    });
  const faqs = await tx.productFaq.findMany({
    where: { product_id: id },
    select: { id: true },
  });
  if (faqs.length) {
    await tx.productFaqTranslation.deleteMany({
      where: { faq_id: { in: faqs.map((f) => f.id) } },
    });
    await tx.productFaq.deleteMany({ where: { product_id: id } });
  }
  for (const f of s.faqs) {
    const faq = await tx.productFaq.create({
      data: { product_id: id, sort_order: f.sort_order },
      select: { id: true },
    });
    await tx.productFaqTranslation.create({
      data: { faq_id: faq.id, locale, question: f.question, answer: f.answer },
    });
  }
  await tx.productCreatorCategory.deleteMany({ where: { product_id: id } });
  for (const l of before.links) {
    const cat = await tx.creatorCategory.findUnique({
      where: { id: l.creator_category_id },
      select: { id: true },
    });
    if (cat)
      await tx.productCreatorCategory.create({
        data: {
          product_id: id,
          creator_category_id: l.creator_category_id,
          sort_order: l.sort_order,
        },
      });
  }
  await restoreLedger(tx, ledgerId, before.ledger);
}

/** URLs per `OR … contains` query against the texts (M5 B14). */
const LIKE_GROUP = 50;

/**
 * Deletes the run's media files that nothing references any more. Every
 * lookup is a batched `IN` query or a batched `contains` (SQL LIKE) over
 * the creator's texts, one page of products at a time (fix 14, M5 B14): no
 * text blob of the whole store is ever built in memory.
 */
async function rollbackMedia(
  deps: RollbackDeps,
  items: ApplyItem[],
): Promise<number> {
  const { prisma, storeId, runId } = deps;
  const media = await prisma.importMedia.findMany({
    where: { store_id: storeId, first_run_id: runId },
  });
  if (!media.length) return 0;
  const publicUrls = [
    ...new Set(media.map((m) => m.public_url).filter((u): u is string => !!u)),
  ];
  const privateKeys = [
    ...new Set(media.map((m) => m.private_key).filter((k): k is string => !!k)),
  ];
  const usedPublic = new Set<string>();
  const usedPrivate = new Set<string>();
  for (const part of chunks(publicUrls)) {
    const [imgs, cats, others, help] = await Promise.all([
      prisma.productImage.findMany({
        where: { url: { in: part } },
        select: { url: true },
      }),
      prisma.creatorCategory.findMany({
        where: { thumbnail_url: { in: part } },
        select: { thumbnail_url: true },
      }),
      prisma.importMedia.findMany({
        where: {
          store_id: storeId,
          public_url: { in: part },
          first_run_id: { not: runId },
        },
        select: { public_url: true },
      }),
      prisma.customFieldTranslation.findMany({
        where: { help_image_url: { in: part } },
        select: { help_image_url: true },
      }),
    ]);
    for (const r of imgs) usedPublic.add(r.url);
    for (const r of cats) if (r.thumbnail_url) usedPublic.add(r.thumbnail_url);
    for (const r of others) if (r.public_url) usedPublic.add(r.public_url);
    for (const r of help)
      if (r.help_image_url) usedPublic.add(r.help_image_url);
  }
  for (const part of chunks(privateKeys)) {
    const others = await prisma.importMedia.findMany({
      where: {
        store_id: storeId,
        private_key: { in: part },
        first_run_id: { not: runId },
      },
      select: { private_key: true },
    });
    for (const r of others) if (r.private_key) usedPrivate.add(r.private_key);
  }

  // Texts that may embed an uploaded URL: option configs, descriptions, FAQs
  // — paged over the creator's products; each page is checked and dropped.
  let pending = publicUrls.filter((u) => !usedPublic.has(u));
  const markFound = (texts: string[]) => {
    if (!pending.length) return;
    for (const t of texts)
      for (const u of pending) if (t.includes(u)) usedPublic.add(u);
    pending = pending.filter((u) => !usedPublic.has(u));
  };
  for (let skip = 0; pending.length; skip += SNAPSHOT_PAGE) {
    const products = await prisma.product.findMany({
      where: { creator_id: deps.creatorId },
      orderBy: { id: 'asc' },
      skip,
      take: SNAPSHOT_PAGE,
      select: { id: true, variant_option_config: true },
    });
    if (!products.length) break;
    markFound(
      products
        .filter((p) => p.variant_option_config)
        .map((p) => JSON.stringify(p.variant_option_config)),
    );
    const ids = products.map((p) => p.id);
    const faqIds = (
      await prisma.productFaq.findMany({
        where: { product_id: { in: ids } },
        select: { id: true },
      })
    ).map((f) => f.id);
    // Per-URL LIKE, grouped: only rows that contain one of the URLs come back.
    for (const group of chunks(pending, LIKE_GROUP)) {
      if (!group.length) continue;
      const [trs, answers] = await Promise.all([
        prisma.productTranslation.findMany({
          where: {
            product_id: { in: ids },
            OR: group.flatMap((u) => [
              { description: { contains: u } },
              { short_description: { contains: u } },
            ]),
          },
          select: { description: true, short_description: true },
        }),
        faqIds.length
          ? prisma.productFaqTranslation.findMany({
              where: {
                faq_id: { in: faqIds },
                OR: group.map((u) => ({ answer: { contains: u } })),
              },
              select: { answer: true },
            })
          : Promise.resolve([] as { answer: string }[]),
      ]);
      markFound([
        ...trs.flatMap((t) => [t.description ?? '', t.short_description ?? '']),
        ...answers.map((a) => a.answer),
      ]);
    }
    if (products.length < SNAPSHOT_PAGE) break;
  }
  // Staged template payloads (private keys), paged the same way.
  if (privateKeys.length) {
    let pendingPrivate = privateKeys.filter((k) => !usedPrivate.has(k));
    for (let skip = 0; pendingPrivate.length; skip += SNAPSHOT_PAGE) {
      const staged = await prisma.importEntity.findMany({
        where: {
          store_id: storeId,
          entity_type: 'DESIGN_TEMPLATE',
          status: { not: ImportEntityStatus.ROLLED_BACK },
        },
        orderBy: { id: 'asc' },
        skip,
        take: SNAPSHOT_PAGE,
        select: { payload: true },
      });
      if (!staged.length) break;
      for (const p of staged) {
        const text = JSON.stringify(p.payload ?? null);
        for (const k of pendingPrivate)
          if (text.includes(k)) usedPrivate.add(k);
      }
      pendingPrivate = pendingPrivate.filter((k) => !usedPrivate.has(k));
      if (staged.length < SNAPSHOT_PAGE) break;
    }
  }

  let deleted = 0;
  const deletedFiles = new Set<string>();
  for (const m of media) {
    const referenced =
      (!!m.public_url && usedPublic.has(m.public_url)) ||
      (!!m.private_key && usedPrivate.has(m.private_key));
    if (referenced) continue;
    if (m.public_url && !deletedFiles.has(m.public_url)) {
      deletedFiles.add(m.public_url);
      await deps.uploads.deleteFile(m.public_url).catch(() => undefined);
    }
    if (m.private_key && !deletedFiles.has(m.private_key)) {
      deletedFiles.add(m.private_key);
      await deps.storage.delete(m.private_key).catch(() => false);
    }
    await prisma.importMedia.delete({ where: { id: m.id } });
    deleted++;
    items.push({
      entity_type: 'MEDIA',
      external_ref: m.source_url.slice(0, 255),
      action: 'DELETE',
      target_id: m.id,
    });
  }
  return deleted;
}
