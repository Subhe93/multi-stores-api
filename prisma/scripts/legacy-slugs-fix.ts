/**
 * One-off repair of legacy product slugs under the WordPress slug rules
 * (plans/slug-wp-rules/PLAN.md §8, inventory prod-slug-inventory.sql):
 * ProductTranslation.slug and CustomProductTranslation.slug that are blank
 * (only dashes), have an edge or doubled dash, upper case, or duplicate
 * another product of the same `/products/<slug>` domain; optionally the
 * platform Category.slug. Rules: legacy-slugs-fix.planner.ts.
 *
 * Every changed slug of a PUBLISHED product of an existing store gets the
 * app's old-slug 301 (StoreRedirect, source SLUG_CHANGE, status 301,
 * `/products/<old>` and `/<locale>/products/<old>` forms) written by
 * RedirectsService.applySlugChangeRedirects inside the same transaction
 * (chains flattened, MANUAL rows left alone, rows shadowing a new path
 * switched off). DRAFT / PENDING_REVIEW / ... rows only get the new slug.
 *
 * Modes:
 *   --dry-run (default)        print the plan and its fingerprint; no writes
 *   --apply --fingerprint=<h>  re-plan inside ONE transaction, abort when the
 *                              fingerprint differs (exit 2), then write
 *   --only-store=<slug>        only that store's products (no provider products)
 *   --include-categories       also platform categories (never a redirect)
 *
 * Exit codes: 0 done / nothing to fix, 1 error, 2 fingerprint mismatch.
 * Idempotent: after an apply a dry run prints "Nothing to fix.".
 * The API caches redirect maps 60 s and the storefront caches product pages
 * per store tag; both catch up on their own TTL.
 *
 * Run with:  npx ts-node prisma/scripts/legacy-slugs-fix.ts
 *            npx ts-node prisma/scripts/legacy-slugs-fix.ts --apply --fingerprint=<hash>
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { RedirectsService } from '../../src/modules/redirects/redirects.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  buildPlan,
  fingerprint,
  isNoop,
  parseArgs,
  renderPlan,
  type Options,
  type Plan,
  type SnapEntity,
  type SnapStore,
  type Snapshot,
} from './legacy-slugs-fix.planner';

type Db = PrismaClient | Prisma.TransactionClient;

class FingerprintMismatch extends Error {}

// ── Loader ──────────────────────────────────────────────────────────────────

async function loadSnapshot(db: Db, opts: Options): Promise<Snapshot | null> {
  const stores = await db.store.findMany({
    where: opts.onlyStore ? { slug: opts.onlyStore } : {},
    select: {
      id: true,
      slug: true,
      creator_id: true,
      language_config: { select: { primary_locale: true } },
    },
  });
  if (opts.onlyStore && !stores.length) return null;
  const storeByCreator = new Map<string, SnapStore>(
    stores.map((s) => [
      s.creator_id,
      {
        id: s.id,
        slug: s.slug,
        primary_locale: s.language_config?.primary_locale || 'en',
      },
    ]),
  );
  const creatorFilter = opts.onlyStore
    ? { creator_id: stores[0].creator_id }
    : {};
  const tr = { select: { id: true, locale: true, title: true, slug: true } };
  const [products, customProducts] = await Promise.all([
    db.product.findMany({
      where: creatorFilter,
      select: {
        id: true,
        creator_id: true,
        provider_id: true,
        status: true,
        created_at: true,
        translations: tr,
      },
    }),
    db.customProduct.findMany({
      where: creatorFilter,
      select: {
        id: true,
        creator_id: true,
        status: true,
        created_at: true,
        translations: tr,
      },
    }),
  ]);
  const entities: SnapEntity[] = [
    ...products.map((p) => ({
      kind: 'product' as const,
      id: p.id,
      creator_id: p.creator_id,
      provider_id: p.provider_id,
      store: p.creator_id ? (storeByCreator.get(p.creator_id) ?? null) : null,
      status: p.status,
      created_at: p.created_at.toISOString(),
      translations: p.translations,
    })),
    ...customProducts.map((p) => ({
      kind: 'custom_product' as const,
      id: p.id,
      creator_id: p.creator_id,
      provider_id: null,
      store: storeByCreator.get(p.creator_id) ?? null,
      status: p.status,
      created_at: p.created_at.toISOString(),
      translations: p.translations,
    })),
  ];
  const categories = opts.includeCategories
    ? (
        await db.category.findMany({
          select: {
            id: true,
            slug: true,
            is_active: true,
            translations: { select: { locale: true, name: true } },
          },
        })
      ).map((c) => ({
        id: c.id,
        slug: c.slug,
        is_active: c.is_active,
        names: [
          ...c.translations.filter((t) => t.locale === 'en'),
          ...c.translations.filter((t) => t.locale !== 'en'),
        ].map((t) => t.name),
      }))
    : [];
  return { entities, categories };
}

// ── Writer ──────────────────────────────────────────────────────────────────

async function applyPlan(
  tx: Prisma.TransactionClient,
  plan: Plan,
): Promise<void> {
  for (const c of plan.changes) {
    if (c.entity === 'product')
      await tx.productTranslation.update({
        where: { id: c.row_id },
        data: { slug: c.new_slug },
      });
    else if (c.entity === 'custom_product')
      await tx.customProductTranslation.update({
        where: { id: c.row_id },
        data: { slug: c.new_slug },
      });
    else
      await tx.category.update({
        where: { id: c.row_id },
        data: { slug: c.new_slug },
      });
  }
  // The app's old-slug 301 writer, run in this transaction (it throws on a
  // DB error when given `tx`, which rolls everything back).
  const redirects = new RedirectsService(tx as unknown as PrismaService);
  for (const s of plan.redirects) {
    const res = await redirects.applySlugChangeRedirects(
      s.store_id,
      s.moves,
      tx,
    );
    for (const c of res?.conflicts ?? [])
      console.warn(
        `  ! ${s.store_slug}: ${c.from_path} -> ${c.to_path} not written (${c.code})`,
      );
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  let opts: Options;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    console.error(
      'Usage: legacy-slugs-fix.ts [--dry-run | --apply --fingerprint=<hash>] [--only-store=<slug>] [--include-categories]',
    );
    return 1;
  }
  const prisma = new PrismaClient();
  try {
    const snap = await loadSnapshot(prisma, opts);
    if (!snap) {
      console.error(`Store "${opts.onlyStore}" not found.`);
      return 1;
    }
    const plan = await buildPlan(snap);
    console.log(renderPlan(plan));
    if (isNoop(plan)) return 0;
    const fp = fingerprint(plan);
    console.log(`\nFingerprint: ${fp}`);
    if (opts.mode === 'dry-run') {
      const flags = [
        opts.onlyStore ? `--only-store=${opts.onlyStore}` : '',
        opts.includeCategories ? '--include-categories' : '',
      ]
        .filter(Boolean)
        .join(' ');
      console.log(
        `\nDry run only. Apply with: --apply --fingerprint=${fp}${flags ? ` ${flags}` : ''}`,
      );
      return 0;
    }
    if (opts.fingerprint !== fp) {
      console.error(
        `Fingerprint mismatch: given ${opts.fingerprint}, planned ${fp}. Re-run the dry run.`,
      );
      return 2;
    }
    await prisma.$transaction(
      async (tx) => {
        // Re-plan inside the transaction so edits made since the dry run
        // cannot slip in between the reviewed plan and the writes.
        const again = await loadSnapshot(tx, opts);
        if (!again) throw new Error('store vanished');
        const fresh = await buildPlan(again);
        if (fingerprint(fresh) !== opts.fingerprint)
          throw new FingerprintMismatch(
            'the data changed since the dry run; re-run it',
          );
        await applyPlan(tx, fresh);
      },
      { timeout: 300_000, maxWait: 30_000 },
    );
    console.log(
      `Applied: ${plan.changes.length} slugs changed, ${plan.counts.redirect_moves} redirect paths planned.`,
    );
    return 0;
  } catch (err) {
    if (err instanceof FingerprintMismatch) {
      console.error(`Fingerprint mismatch: ${err.message}`);
      return 2;
    }
    throw err;
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
