import type { Prisma } from '@prisma/client';
import { resolveStoreCurrency } from '../../../common/money/currency.util';
import type { ExistingRedirectRow } from '../../redirects/redirect-plan';
import type { NormalizedCatalog } from '../model/normalized';
import {
  categoryStateHash,
  productStateHash,
  shippingMethodStateHash,
  shippingProfileStateHash,
  shippingZoneStateHash,
  type ProductStateRows,
} from '../mapping/state';
import type { ImportRunOptions } from '../runs/run-options';
import {
  ledgerKey,
  type LedgerRow,
  type SnapshotCategory,
  type SnapshotProduct,
  type SnapshotVariant,
  type TargetSnapshot,
} from './target-snapshot';

type Db = Prisma.TransactionClient;

/** Rows per query (M5 B14: 500, so a 20k-product store never loads one giant page). */
export const SNAPSHOT_PAGE = 500;
const CHUNK = SNAPSHOT_PAGE;

function chunks<T>(list: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/**
 * Pages a table with offset/limit in the given order until a short page;
 * the callback consumes one page at a time so only that page is held.
 */
async function forEachPage<T>(
  fetch: (skip: number, take: number) => Promise<T[]>,
  consume: (rows: T[]) => void,
): Promise<void> {
  for (let skip = 0; ; skip += SNAPSHOT_PAGE) {
    const rows = await fetch(skip, SNAPSHOT_PAGE);
    consume(rows);
    if (rows.length < SNAPSHOT_PAGE) return;
  }
}

/**
 * M5 B14: a cheap "did the store change" stamp (counts + newest
 * `updated_at` / `created_at` of every table the planner reads), so the plan
 * built for the confirm check can be reused by the apply step.
 */
export async function loadStoreStateStamp(
  db: Db,
  storeId: string,
): Promise<string> {
  const store = await db.store.findUnique({
    where: { id: storeId },
    select: { creator_id: true },
  });
  const creatorId = store?.creator_id ?? '';
  const [products, categories, ledger, redirects, media, profiles] =
    await Promise.all([
      db.product.aggregate({
        where: { creator_id: creatorId },
        _count: { _all: true },
        _max: { updated_at: true },
      }),
      db.creatorCategory.aggregate({
        where: { creator_id: creatorId },
        _count: { _all: true },
        _max: { updated_at: true },
      }),
      db.importEntity.aggregate({
        where: { store_id: storeId },
        _count: { _all: true },
        _max: { updated_at: true },
      }),
      db.storeRedirect.aggregate({
        where: { store_id: storeId },
        _count: { _all: true },
        _max: { updated_at: true },
      }),
      db.importMedia.aggregate({
        where: { store_id: storeId },
        _count: { _all: true },
        _max: { created_at: true },
      }),
      db.shippingProfile.aggregate({
        where: { creator_id: creatorId },
        _count: { _all: true },
        _max: { created_at: true },
      }),
    ]);
  const t = (d: Date | null | undefined) => (d ? d.getTime() : 0);
  return [
    products._count._all,
    t(products._max.updated_at),
    categories._count._all,
    t(categories._max.updated_at),
    ledger._count._all,
    t(ledger._max.updated_at),
    redirects._count._all,
    t(redirects._max.updated_at),
    media._count._all,
    t(media._max.created_at),
    profiles._count._all,
    t(profiles._max.created_at),
  ].join('|');
}

export function groupBy<T, K>(list: T[], key: (t: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const item of list) {
    const k = key(item);
    const bucket = out.get(k);
    if (bucket) bucket.push(item);
    else out.set(k, [item]);
  }
  return out;
}

/** Managed-field rows of products (state.ts) for the primary locale. */
export async function loadProductStateRows(
  db: Db,
  productIds: string[],
  locale: string,
): Promise<Map<string, ProductStateRows>> {
  const out = new Map<string, ProductStateRows>();
  for (const ids of chunks(productIds)) {
    if (!ids.length) continue;
    const [products, translations, variants, images, tags, faqs] =
      await Promise.all([
        db.product.findMany({
          where: { id: { in: ids } },
          select: {
            id: true,
            status: true,
            product_type: true,
            customization_type: true,
            base_price: true,
            compare_at_price: true,
            sku: true,
            track_inventory: true,
            weight: true,
            tax_exempt: true,
            category_id: true,
            variant_option_config: true,
            shipping_profile_id: true,
          },
        }),
        db.productTranslation.findMany({
          where: { product_id: { in: ids }, locale },
          select: {
            product_id: true,
            title: true,
            slug: true,
            description: true,
            short_description: true,
            meta_title: true,
            meta_desc: true,
          },
        }),
        db.productVariant.findMany({
          where: { product_id: { in: ids } },
          select: {
            id: true,
            product_id: true,
            external_ref: true,
            sku: true,
            price_adjustment: true,
            compare_at_price: true,
            is_active: true,
            options: true,
          },
        }),
        db.productImage.findMany({
          where: { product_id: { in: ids } },
          select: {
            product_id: true,
            url: true,
            alt_text: true,
            sort_order: true,
            is_featured: true,
            variant_id: true,
          },
        }),
        db.productTag.findMany({
          where: { product_id: { in: ids } },
          select: { product_id: true, tag: true },
        }),
        db.productFaq.findMany({
          where: { product_id: { in: ids } },
          select: { id: true, product_id: true, sort_order: true },
        }),
      ]);
    const faqTr = faqs.length
      ? await db.productFaqTranslation.findMany({
          where: { faq_id: { in: faqs.map((f) => f.id) }, locale },
          select: { faq_id: true, question: true, answer: true },
        })
      : [];
    const trByFaq = new Map(faqTr.map((t) => [t.faq_id, t]));
    // Group once (fix 21: no per-product scans of the chunk).
    const trByProduct = new Map(translations.map((t) => [t.product_id, t]));
    const variantsOf = groupBy(variants, (v) => v.product_id);
    const imagesOf = groupBy(images, (i) => i.product_id);
    const tagsOf = groupBy(tags, (t) => t.product_id);
    const faqsOf = groupBy(faqs, (f) => f.product_id);
    for (const p of products) {
      out.set(p.id, {
        product: p,
        translation: trByProduct.get(p.id) ?? null,
        variants: variantsOf.get(p.id) ?? [],
        images: imagesOf.get(p.id) ?? [],
        tags: tagsOf.get(p.id) ?? [],
        faqs: (faqsOf.get(p.id) ?? []).map((f) => ({
          sort_order: f.sort_order,
          question: trByFaq.get(f.id)?.question ?? '',
          answer: trByFaq.get(f.id)?.answer ?? '',
        })),
      });
    }
  }
  return out;
}

export interface SnapshotLoadInput {
  db: Db;
  storeId: string;
  catalog: NormalizedCatalog;
  options: ImportRunOptions;
  personalizationAvailable: boolean;
  designerAvailable: boolean;
  redirects: ExistingRedirectRow[];
}

export async function loadTargetSnapshot(
  input: SnapshotLoadInput,
): Promise<TargetSnapshot> {
  const { db, storeId, catalog, options } = input;
  const store = await db.store.findUnique({
    where: { id: storeId },
    select: {
      id: true,
      creator_id: true,
      currency: true,
      store_type: true,
      tax_pricing_mode: true,
      language_config: { select: { primary_locale: true } },
    },
  });
  if (!store) throw new Error(`Store ${storeId} not found`);
  const creatorId = store.creator_id;
  const primaryLocale = store.language_config?.primary_locale ?? 'en';

  const defaultMarket = await db.market.findFirst({
    where: { store_id: storeId, is_default: true },
    select: { currency: true },
  });
  let currency = defaultMarket?.currency ?? null;
  if (!currency) {
    const config = await db.platformConfig.findFirst({
      select: { default_currency: true },
    });
    currency = resolveStoreCurrency(store, config?.default_currency ?? null);
  }

  const platformCategoryExists = options.platform_category_id
    ? !!(await db.category.findUnique({
        where: { id: options.platform_category_id },
        select: { id: true },
      }))
    : false;
  /** Per-page follow-up queries awaited after the page loop. */
  const pending: Promise<void>[] = [];

  // Ledger: paged (M5 B14); the payload is only read for PRODUCT rows (fix 1).
  const ledger = new Map<string, LedgerRow>();
  const ledgerRows: LedgerRow[] = [];
  await forEachPage(
    (skip, take) =>
      db.importEntity.findMany({
        where: { store_id: storeId },
        orderBy: { id: 'asc' },
        skip,
        take,
        select: {
          id: true,
          entity_type: true,
          external_ref: true,
          target_id: true,
          source_hash: true,
          applied_hash: true,
          created_by_import: true,
          status: true,
          first_run_id: true,
          last_run_id: true,
          payload: true,
        },
      }),
    (rows) => {
      for (const r of rows) {
        const row: LedgerRow =
          r.entity_type === 'PRODUCT' ? r : { ...r, payload: undefined };
        ledgerRows.push(row);
        ledger.set(ledgerKey(r.entity_type, r.external_ref), row);
      }
    },
  );

  // Products: every product of the creator (slugs, paged), full state only
  // for the ones the catalog or the ledger refers to (M5 B14).
  const sourceRefs = new Set(catalog.products.map((p) => p.ext_id));
  const productSlugs = new Map<string, string>();
  const publishedProductSlugs = new Set<string>();
  const slugById = new Map<string, string>();
  /** Imported products the plan needs: catalog refs (full state) and ledger-only refs (id/status). */
  const needed: { id: string; status: string; external_ref: string }[] = [];
  const trackedRefs = new Set(
    ledgerRows
      .filter((r) => r.entity_type === 'PRODUCT')
      .map((r) => r.external_ref),
  );
  await forEachPage(
    (skip, take) =>
      db.product.findMany({
        where: { creator_id: creatorId },
        orderBy: { id: 'asc' },
        skip,
        take,
        select: { id: true, status: true, external_ref: true },
      }),
    (rows) => {
      for (const p of rows)
        if (
          p.external_ref &&
          (sourceRefs.has(p.external_ref) || trackedRefs.has(p.external_ref))
        )
          needed.push({
            id: p.id,
            status: p.status,
            external_ref: p.external_ref,
          });
      const statusById = new Map(rows.map((p) => [p.id, p.status]));
      // Slugs of this page (one query per page, nothing else kept).
      pending.push(
        db.productTranslation
          .findMany({
            where: {
              product_id: { in: rows.map((p) => p.id) },
              locale: primaryLocale,
            },
            select: { product_id: true, slug: true },
          })
          .then((trs) => {
            for (const t of trs) {
              productSlugs.set(t.slug, t.product_id);
              slugById.set(t.product_id, t.slug);
              if (statusById.get(t.product_id) === 'PUBLISHED')
                publishedProductSlugs.add(t.slug);
            }
          }),
      );
    },
  );
  await Promise.all(pending.splice(0));
  const withState = needed.filter((p) => sourceRefs.has(p.external_ref));
  const productsByRef = new Map<string, SnapshotProduct>();
  const variantsByProduct = new Map<string, SnapshotVariant[]>();
  const productCategoryLinks = new Map<string, Set<string>>();
  for (const page of chunks(withState)) {
    if (!page.length) continue;
    const ids = page.map((p) => p.id);
    const [states, links] = await Promise.all([
      loadProductStateRows(db, ids, primaryLocale),
      db.productCreatorCategory.findMany({
        where: { product_id: { in: ids } },
        select: { product_id: true, creator_category_id: true },
      }),
    ]);
    for (const l of links) {
      const set = productCategoryLinks.get(l.product_id) ?? new Set<string>();
      set.add(l.creator_category_id);
      productCategoryLinks.set(l.product_id, set);
    }
    for (const p of page) {
      const rows = states.get(p.id);
      if (!rows) continue;
      productsByRef.set(p.external_ref, {
        id: p.id,
        slug: slugById.get(p.id) ?? null,
        status: p.status,
        state_hash: productStateHash(rows),
      });
      variantsByProduct.set(
        p.id,
        rows.variants.map((v) => ({
          id: v.id,
          product_id: p.id,
          external_ref: v.external_ref,
          is_active: v.is_active,
        })),
      );
    }
  }
  // Ledger-tracked products that left the source: id and status only
  // (`on_source_removed`); their managed fields are not compared.
  for (const p of needed)
    if (!productsByRef.has(p.external_ref))
      productsByRef.set(p.external_ref, {
        id: p.id,
        slug: slugById.get(p.id) ?? null,
        status: p.status,
        state_hash: '',
      });

  const sourceSkus = [
    ...new Set(
      catalog.products.flatMap((p) =>
        p.variations.map((v) => v.sku).filter((s): s is string => !!s),
      ),
    ),
  ];
  const skuOwners = new Map<
    string,
    { product_id: string; external_ref: string | null }
  >();
  for (const skus of chunks(sourceSkus)) {
    const rows = await db.productVariant.findMany({
      where: { sku: { in: skus } },
      select: { sku: true, product_id: true, external_ref: true },
    });
    for (const r of rows)
      if (r.sku)
        skuOwners.set(r.sku, {
          product_id: r.product_id,
          external_ref: r.external_ref,
        });
  }

  const cats = await db.creatorCategory.findMany({
    where: { creator_id: creatorId },
    select: {
      id: true,
      slug: true,
      parent_id: true,
      sort_order: true,
      is_active: true,
      noindex_when_empty: true,
      thumbnail_url: true,
      external_ref: true,
      visibility: true,
    },
  });
  const catTr = cats.length
    ? await db.creatorCategoryTranslation.findMany({
        where: {
          creator_category_id: { in: cats.map((c) => c.id) },
          locale: primaryLocale,
        },
        select: {
          creator_category_id: true,
          name: true,
          description: true,
          meta_title: true,
          meta_desc: true,
        },
      })
    : [];
  const categoriesByRef = new Map<string, SnapshotCategory>();
  const categoriesBySlug = new Map<string, SnapshotCategory>();
  const trByCat = new Map(catTr.map((t) => [t.creator_category_id, t]));
  for (const c of cats) {
    const sc: SnapshotCategory = {
      id: c.id,
      slug: c.slug,
      parent_id: c.parent_id,
      external_ref: c.external_ref,
      is_active: c.is_active,
      visibility: c.visibility,
      state_hash: categoryStateHash({
        category: c,
        translation: trByCat.get(c.id) ?? null,
      }),
    };
    categoriesBySlug.set(c.slug, sc);
    if (c.external_ref) categoriesByRef.set(c.external_ref, sc);
  }

  const shippingStates = new Map<string, string>();
  const ledgerByType = groupBy(ledgerRows, (r) => r.entity_type);
  const idsOf = (type: string) =>
    (ledgerByType.get(type) ?? [])
      .filter((r) => r.target_id)
      .map((r) => r.target_id!);
  const profileIds = idsOf('SHIPPING_PROFILE');
  if (profileIds.length)
    for (const p of await db.shippingProfile.findMany({
      where: { id: { in: profileIds } },
      select: { id: true, name: true },
    }))
      shippingStates.set(p.id, shippingProfileStateHash(p));
  const zoneIds = idsOf('SHIPPING_ZONE');
  if (zoneIds.length)
    for (const z of await db.shippingZone.findMany({
      where: { id: { in: zoneIds } },
    }))
      shippingStates.set(z.id, shippingZoneStateHash(z));
  const methodIds = idsOf('SHIPPING_METHOD');
  if (methodIds.length)
    for (const m of await db.shippingMethod.findMany({
      where: { id: { in: methodIds } },
    }))
      shippingStates.set(m.id, shippingMethodStateHash(m));
  const creatorHasDefaultProfile =
    (await db.shippingProfile.count({
      where: { creator_id: creatorId, is_default: true },
    })) > 0;

  // Media ledger, paged; two booleans per URL are kept.
  const media = new Map<string, { public: boolean; private: boolean }>();
  await forEachPage(
    (skip, take) =>
      db.importMedia.findMany({
        where: { store_id: storeId },
        orderBy: { id: 'asc' },
        skip,
        take,
        select: { source_url: true, public_url: true, private_key: true },
      }),
    (rows) => {
      for (const m of rows)
        media.set(m.source_url, {
          public: !!m.public_url,
          private: !!m.private_key,
        });
    },
  );

  return {
    storeId,
    creatorId,
    primaryLocale,
    currency,
    taxPricingMode: store.tax_pricing_mode,
    platformCategoryExists,
    personalizationAvailable: input.personalizationAvailable,
    designerAvailable: input.designerAvailable,
    ledger,
    productsByRef,
    productSlugs,
    publishedProductSlugs,
    variantsByProduct,
    productCategoryLinks,
    skuOwners,
    categoriesByRef,
    categoriesBySlug,
    shippingStates,
    creatorHasDefaultProfile,
    media,
    redirects: input.redirects,
  };
}
