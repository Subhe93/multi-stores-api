/**
 * One-time content fix for the occasion landing pages of ONE store
 * (2026-11-10, Namez request): the `collection-products` heading the old
 * preset wrote ("Our picks" / "Våra favoriter" / …) is removed and replaced
 * by the small plain `subheading` of the current preset ("Find your
 * favourite" / "Hitta din favorit" / …), and the `rich-text` heading ("About
 * these gifts" / "Om dessa presenter" / …) is removed, so the hero stays the
 * only heading of the page. Rules: occasion-headings-fix.planner.ts.
 *
 *   - pages of type LANDING whose visible sections are hero-banner,
 *     collection-products[, rich-text[, faq-list]] (the occasion preset
 *     shape); other shapes are listed in the report
 *   - only headings equal to the old preset text of their locale change; an
 *     owner-edited heading is kept and reported ("custom heading kept"); an
 *     existing non-empty subheading is kept
 *   - the edits go to the PageSectionTranslation rows (live draft) AND, in
 *     place, to the published PageVersion.snapshot the storefront renders
 *     (no new version, no republish); an unpublished draft gets the
 *     translation edits only
 *
 * Modes:
 *   --store <slug>        required
 *   --dry-run (default)   print the plan and its fingerprint; no writes
 *   --apply --fingerprint=<hash>
 *                         re-plan inside ONE transaction, abort when the
 *                         fingerprint differs from the one given, then write
 *
 * Idempotent: a second run finds no old heading and prints
 * "Nothing to write (already converted)".
 *
 * After an apply the storefront cache of the store is revalidated the same
 * way a dashboard publish does (STOREFRONT_URL + REVALIDATE_SECRET from the
 * API env; skipped with a warning when they are missing — the storefront's
 * time-based revalidation then catches up on its own).
 *
 * Run with:  npx ts-node prisma/scripts/occasion-headings-fix.ts --store namez --dry-run
 *            npx ts-node prisma/scripts/occasion-headings-fix.ts --store namez --apply --fingerprint=<hash>
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { RevalidationService } from '../../src/common/revalidation/revalidation.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import {
  buildPlan,
  fingerprint,
  isNoop,
  parseArgs,
  renderPlan,
  type Plan,
  type PublishedSnapshot,
  type Snapshot,
} from './occasion-headings-fix.planner';

type Db = PrismaClient | Prisma.TransactionClient;

// ── Loader ──────────────────────────────────────────────────────────────────

async function loadSnapshot(
  db: Db,
  storeSlug: string,
): Promise<Snapshot | null> {
  const store = await db.store.findUnique({
    where: { slug: storeSlug },
    select: { id: true, slug: true },
  });
  if (!store) return null;

  const pages = await db.page.findMany({
    where: { store_id: store.id, type: 'LANDING' },
    orderBy: { created_at: 'asc' },
    select: {
      id: true,
      slug: true,
      // Hidden sections are not part of the publish snapshot, so the shape
      // check ignores them too.
      sections: {
        where: { is_hidden: false },
        orderBy: { sort_order: 'asc' },
        select: {
          id: true,
          section_key: true,
          sort_order: true,
          translations: { select: { locale: true, content: true } },
        },
      },
      published_version: { select: { id: true, snapshot: true } },
    },
  });

  const asContent = (v: Prisma.JsonValue): Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};

  return {
    store,
    pages: pages.map((p) => ({
      id: p.id,
      slug: p.slug,
      sections: p.sections.map((s) => ({
        id: s.id,
        section_key: s.section_key,
        sort_order: s.sort_order,
        translations: s.translations.map((t) => ({
          locale: t.locale,
          content: asContent(t.content),
        })),
      })),
      published_version: p.published_version
        ? {
            id: p.published_version.id,
            snapshot: p.published_version.snapshot as PublishedSnapshot,
          }
        : null,
    })),
  };
}

// ── Writer ──────────────────────────────────────────────────────────────────

async function applyPlan(
  tx: Prisma.TransactionClient,
  plan: Plan,
): Promise<void> {
  for (const page of plan.pages) {
    for (const e of page.translation_edits) {
      await tx.pageSectionTranslation.update({
        where: {
          section_id_locale: { section_id: e.section_id, locale: e.locale },
        },
        data: { content: e.content_after as Prisma.InputJsonValue },
      });
    }
    if (page.snapshot_edit) {
      await tx.pageVersion.update({
        where: { id: page.snapshot_edit.version_id },
        data: {
          snapshot: page.snapshot_edit.snapshot_after as Prisma.InputJsonValue,
        },
      });
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();
  try {
    const snapshot = await loadSnapshot(prisma, opts.store!);
    if (!snapshot) {
      console.error(`Store "${opts.store}" not found.`);
      return 1;
    }
    const plan = buildPlan(snapshot);
    console.log(renderPlan(plan));
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
    if (!opts.fingerprint) {
      console.error('--apply needs --fingerprint=<hash> from the dry run.');
      return 1;
    }
    if (opts.fingerprint !== fp) {
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
        const fresh = buildPlan(again);
        if (fingerprint(fresh) !== fp)
          throw new Error('the data changed since the plan was built; re-run');
        await applyPlan(tx, fresh);
      },
      { timeout: 120_000 },
    );
    const c = plan.counts;
    console.log(
      `Applied: ${c.pages_matched} pages, ${c.translations_to_edit} section translations, ${c.snapshots_to_edit} published snapshots; kept ${c.custom_headings_kept} custom headings, ${c.unmapped_locale_kept} headings in an unmapped locale, ${c.subheadings_kept} existing subheadings.`,
    );
    // Best effort, like a dashboard publish: a failure only logs a warning.
    await new RevalidationService(
      prisma as unknown as PrismaService,
    ).revalidateStoreBySlug(plan.store.slug);
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
