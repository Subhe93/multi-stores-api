/**
 * One-time data conversion (tags rename, plans/tags-rename/PLAN.md §C1/§D):
 * the legacy `ProductTag` strings of ONE store become INTERNAL
 * `CreatorCategory` rows ("Tags") linked through `ProductCreatorCategory`
 * (and `CustomProductCreatorCategory` for custom products, via the base
 * product's tags), and the store's smart collections with
 * `match_rule = TAGS` whose `match_tags` still hold legacy strings are
 * re-pointed at those INTERNAL row ids.
 *
 *   - each distinct tag (trimmed, case-insensitive) → an INTERNAL row of the
 *     creator whose primary-locale name matches case-insensitively, else a
 *     new one (name = most common spelling, slug via the WP slug rules with
 *     the `-2` suffix when taken, visibility INTERNAL, is_active, sort_order
 *     appended after the creator's root rows)
 *   - every product / custom product carrying the tag is linked (sort_order
 *     appended; existing links are skipped); `primary_creator_category_id`
 *     is never touched (an INTERNAL row cannot be a primary)
 *   - `ProductTag` rows are NOT deleted (DB cleanup is a later step)
 *
 * Modes:
 *   --store <slug>        required
 *   --dry-run (default)   print the masked plan and its fingerprint; no writes
 *   --apply [--fingerprint=<hash>]
 *                         re-plan inside ONE transaction, abort when the
 *                         fingerprint differs from the one given, then write
 *
 * Idempotent: a second run reuses every row by name and finds every link in
 * place, so it plans nothing and exits. Refuses when the store is unknown or
 * has no legacy tags.
 *
 * Run with:  npx ts-node prisma/scripts/convert-legacy-tags.ts --store muba --dry-run
 *            npx ts-node prisma/scripts/convert-legacy-tags.ts --store muba --apply --fingerprint=<hash>
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  buildPlan,
  fingerprint,
  isNoop,
  parseArgs,
  renderPlan,
  type Plan,
  type Snapshot,
} from './convert-legacy-tags.planner';

type Db = PrismaClient | Prisma.TransactionClient;

// ── Loader ──────────────────────────────────────────────────────────────────

async function loadSnapshot(
  db: Db,
  storeSlug: string,
): Promise<{ snapshot: Snapshot; titles: Map<string, string> } | null> {
  const store = await db.store.findUnique({
    where: { slug: storeSlug },
    select: {
      id: true,
      slug: true,
      creator_id: true,
      language_config: { select: { primary_locale: true } },
    },
  });
  if (!store?.creator_id) return null;
  const locale = store.language_config?.primary_locale || 'en';
  const creatorId = store.creator_id;

  const products = await db.product.findMany({
    where: { creator_id: creatorId },
    select: {
      id: true,
      tags: { select: { tag: true } },
      translations: { select: { locale: true, title: true } },
    },
  });
  const customProducts = await db.customProduct.findMany({
    where: { creator_id: creatorId },
    select: {
      id: true,
      product_id: true,
      product: { select: { tags: { select: { tag: true } } } },
      translations: { select: { locale: true, title: true } },
    },
  });
  const rows = await db.creatorCategory.findMany({
    where: { creator_id: creatorId },
    select: {
      id: true,
      slug: true,
      parent_id: true,
      sort_order: true,
      visibility: true,
      match_rule: true,
      match_tags: true,
      translations: { select: { locale: true, name: true } },
    },
  });
  const productIds = products.map((p) => p.id);
  const customIds = customProducts.map((p) => p.id);
  const [productLinks, customLinks] = await Promise.all([
    db.productCreatorCategory.findMany({
      where: { product_id: { in: productIds } },
      select: { product_id: true, creator_category_id: true, sort_order: true },
    }),
    db.customProductCreatorCategory.findMany({
      where: { custom_product_id: { in: customIds } },
      select: {
        custom_product_id: true,
        creator_category_id: true,
        sort_order: true,
      },
    }),
  ]);

  const titleOf = (tr: { locale: string; title: string }[]) =>
    tr.find((t) => t.locale === locale)?.title ?? tr[0]?.title ?? '';
  const titles = new Map<string, string>();
  for (const p of products) titles.set(p.id, titleOf(p.translations));
  for (const p of customProducts) titles.set(p.id, titleOf(p.translations));

  const snapshot: Snapshot = {
    store: {
      id: store.id,
      slug: store.slug,
      creator_id: creatorId,
      primary_locale: locale,
    },
    products: products.map((p) => ({
      id: p.id,
      title: titleOf(p.translations),
      tags: p.tags.map((t) => t.tag),
    })),
    custom_products: customProducts.map((p) => ({
      id: p.id,
      base_product_id: p.product_id,
      title: titleOf(p.translations),
      tags: p.product.tags.map((t) => t.tag),
    })),
    internal_rows: rows
      .filter((r) => r.visibility === 'INTERNAL')
      .map((r) => ({
        id: r.id,
        slug: r.slug,
        name: r.translations.find((t) => t.locale === locale)?.name ?? null,
      })),
    all_slugs: rows.map((r) => r.slug),
    max_root_sort_order: rows
      .filter((r) => !r.parent_id)
      .reduce((m, r) => Math.max(m, r.sort_order), -1),
    product_links: productLinks.map((l) => ({
      owner_id: l.product_id,
      creator_category_id: l.creator_category_id,
      sort_order: l.sort_order,
    })),
    custom_product_links: customLinks.map((l) => ({
      owner_id: l.custom_product_id,
      creator_category_id: l.creator_category_id,
      sort_order: l.sort_order,
    })),
    tags_collections: rows
      .filter((r) => r.match_rule === 'TAGS')
      .map((r) => ({ id: r.id, slug: r.slug, match_tags: r.match_tags })),
  };
  return { snapshot, titles };
}

// ── Writer ──────────────────────────────────────────────────────────────────

async function applyPlan(
  tx: Prisma.TransactionClient,
  plan: Plan,
): Promise<void> {
  const { store } = plan;
  const idByKey = new Map<string, string>();
  for (const t of plan.tags) {
    if (t.action === 'REUSE') {
      idByKey.set(t.key, t.id!);
      continue;
    }
    const row = await tx.creatorCategory.create({
      data: {
        creator_id: store.creator_id,
        slug: t.slug!,
        parent_id: null,
        visibility: 'INTERNAL',
        is_active: true,
        sort_order: t.sort_order!,
        match_rule: 'MANUAL',
        match_tags: [],
        translations: {
          create: { locale: store.primary_locale, name: t.name },
        },
      },
      select: { id: true },
    });
    idByKey.set(t.key, row.id);
  }
  const productLinks = plan.links.filter((l) => l.kind === 'product');
  const customLinks = plan.links.filter((l) => l.kind === 'custom_product');
  if (productLinks.length)
    await tx.productCreatorCategory.createMany({
      data: productLinks.map((l) => ({
        product_id: l.owner_id,
        creator_category_id: idByKey.get(l.tag_key)!,
        sort_order: l.sort_order,
      })),
      skipDuplicates: true,
    });
  if (customLinks.length)
    await tx.customProductCreatorCategory.createMany({
      data: customLinks.map((l) => ({
        custom_product_id: l.owner_id,
        creator_category_id: idByKey.get(l.tag_key)!,
        sort_order: l.sort_order,
      })),
      skipDuplicates: true,
    });
  for (const c of plan.collections) {
    const ids = c.after.map((v) =>
      v.startsWith('new:') ? idByKey.get(v.slice(4))! : v,
    );
    await tx.creatorCategory.update({
      where: { id: c.id },
      data: { match_tags: ids },
    });
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const loaded = await loadSnapshot(prisma, opts.store!);
    if (!loaded) {
      console.error(`Store "${opts.store}" not found (or it has no creator).`);
      return 1;
    }
    const plan = buildPlan(loaded.snapshot);
    if (plan.counts.distinct_tags === 0) {
      console.error(
        `Store "${opts.store}" has no legacy tags; nothing to convert.`,
      );
      return 1;
    }
    console.log(renderPlan(plan, loaded.titles));
    const fp = fingerprint(plan);
    console.log(`\nFingerprint: ${fp}`);
    if (isNoop(plan)) {
      console.log('Nothing to write (already converted).');
      return 0;
    }
    if (opts.mode === 'dry-run') {
      console.log(
        `\nDry run only. Apply with: --store ${opts.store} --apply --fingerprint=${fp}`,
      );
      return 0;
    }
    if (opts.fingerprint && opts.fingerprint !== fp) {
      console.error(
        `Fingerprint mismatch: given ${opts.fingerprint}, planned ${fp}. Re-run the dry run.`,
      );
      return 1;
    }
    await prisma.$transaction(
      async (tx) => {
        // Re-plan inside the transaction so concurrent edits cannot slip in
        // between the printed plan and the writes.
        const again = await loadSnapshot(tx, opts.store!);
        if (!again) throw new Error('store vanished');
        const fresh = buildPlan(again.snapshot);
        if (fingerprint(fresh) !== fp)
          throw new Error('the data changed since the plan was built; re-run');
        await applyPlan(tx, fresh);
      },
      { timeout: 120_000 },
    );
    console.log(
      `Applied: ${plan.counts.tags_created} tags created, ${plan.counts.links_to_add} links added, ${plan.counts.collections_to_convert} collections converted.`,
    );
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
