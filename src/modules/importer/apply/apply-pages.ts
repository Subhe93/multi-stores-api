import {
  ImportEntityStatus,
  ImportItemPhase,
  ImportLogLevel,
  Prisma,
} from '@prisma/client';
import { hashOf } from '../mapping/hash';
import { uniqueV2PageSlug } from '../../../common/slug/wp-slug';
import type { MappedPage, PlannedPage } from '../planner/plan-types';
import {
  appliedRefs,
  errorMessage,
  recordItems,
  upsertLedger,
  type ApplyContext,
  type ApplyItem,
  type Tx,
} from './apply-context';

/** Section key of the builder's rich-text section (web theme registry). */
export const IMPORTED_PAGE_SECTION_KEY = 'rich-text';

/** What the ledger `applied_hash` covers: the fields the importer wrote. */
function pageStateHash(m: MappedPage): string {
  return hashOf({
    title: m.title,
    html: m.html,
    meta_title: m.meta_title,
    meta_description: m.meta_description,
    noindex: m.noindex,
  });
}

/**
 * Pages phase (M5 B17, `scopes.pages`): each planned WP page becomes a
 * DRAFT builder page of type LANDING (slug `/<slug>`; STATIC allows only
 * one page per `static_kind`) with one `rich-text` section whose `html`
 * is the sanitized content, the title / meta in the store primary locale
 * and `seo.robots = noindex` when Rank Math had it. Nothing is published.
 * UPDATE only rewrites pages that are still drafts (a page the merchant
 * published is SKIPped); a ledgered page that no longer exists is created
 * again. The ledger row (`PAGE`, `woo:<host>:page:<id>`) carries the
 * page id — `Page` has no external_ref column.
 */
export async function applyPages(
  ctx: ApplyContext,
  planned: PlannedPage[],
): Promise<{ created: number; updated: number; errors: number }> {
  const out = { created: 0, updated: 0, errors: 0 };
  if (!planned.length) return out;
  await ctx.checkpoint();
  const done = await appliedRefs(
    ctx.prisma,
    ctx.runId,
    'PAGE',
    planned.map((p) => p.mapped.ref),
  );
  const items: ApplyItem[] = [];
  for (const p of planned) {
    if (done.has(p.mapped.ref)) continue;
    if (p.action !== 'CREATE' && p.action !== 'UPDATE') {
      items.push({
        entity_type: 'PAGE',
        external_ref: p.mapped.ref,
        action: p.action,
        target_id: p.target_id,
        title: p.mapped.title,
      });
      continue;
    }
    try {
      await ctx.assertClaim(ctx.prisma);
      const item = await ctx.prisma.$transaction(
        (tx) => writePage(tx, ctx, p),
        { timeout: 30_000 },
      );
      items.push(item);
      if (item.action === 'CREATE') out.created++;
      else if (item.action === 'UPDATE') out.updated++;
    } catch (err) {
      out.errors++;
      const unique =
        (err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002') ||
        /unique constraint/i.test(errorMessage(err));
      const message = unique
        ? `a page with the slug ${p.mapped.slug} already exists`
        : errorMessage(err);
      await ctx.log(ImportLogLevel.ERROR, 'IMPORT_PAGE_FAILED', message, {
        entity_type: 'PAGE',
        external_ref: p.mapped.ref,
      });
      items.push({
        entity_type: 'PAGE',
        external_ref: p.mapped.ref,
        action: 'ERROR',
        target_id: p.target_id,
        message,
        title: p.mapped.title,
      });
    }
    if (items.length >= 50) {
      await recordItems(ctx.prisma, ctx.runId, ImportItemPhase.APPLY, items);
      items.length = 0;
      await ctx.checkpoint();
    }
  }
  await recordItems(ctx.prisma, ctx.runId, ImportItemPhase.APPLY, items);
  return out;
}

async function writePage(
  tx: Tx,
  ctx: ApplyContext,
  p: PlannedPage,
): Promise<ApplyItem> {
  const m = p.mapped;
  const seo: Prisma.InputJsonValue = m.noindex ? { robots: 'noindex' } : {};
  const existing = p.target_id
    ? await tx.page.findFirst({
        where: { id: p.target_id, store_id: ctx.storeId },
        select: { id: true, status: true, published_version_id: true },
      })
    : null;
  if (existing) {
    if (existing.status !== 'DRAFT' || existing.published_version_id) {
      return {
        entity_type: 'PAGE',
        external_ref: m.ref,
        action: 'SKIP',
        target_id: existing.id,
        message: 'W_TARGET_MODIFIED_SKIPPED',
        title: m.title,
      };
    }
    await tx.page.update({
      where: { id: existing.id },
      data: { seo },
    });
    await tx.pageTranslation.upsert({
      where: {
        page_id_locale: { page_id: existing.id, locale: ctx.primaryLocale },
      },
      update: {
        title: m.title,
        meta_title: m.meta_title,
        meta_description: m.meta_description,
      },
      create: {
        page_id: existing.id,
        locale: ctx.primaryLocale,
        title: m.title,
        meta_title: m.meta_title,
        meta_description: m.meta_description,
      },
    });
    // Replace the importer's sections only (the page is still a draft).
    await tx.pageSection.deleteMany({ where: { page_id: existing.id } });
    await writeSection(tx, ctx, existing.id, m);
    await upsertLedger(tx, ctx, {
      entity_type: 'PAGE',
      external_ref: m.ref,
      target_id: existing.id,
      source_hash: p.source_hash,
      applied_hash: pageStateHash(m),
      created: false,
      status: ImportEntityStatus.ACTIVE,
      payload: null,
    });
    return {
      entity_type: 'PAGE',
      external_ref: m.ref,
      action: 'UPDATE',
      target_id: existing.id,
      title: m.title,
    };
  }
  const page = await tx.page.create({
    data: {
      store_id: ctx.storeId,
      type: 'LANDING',
      // The planned slug (already unique, reserved / numeric suffixed); the
      // check runs again so a page created since the dry run cannot collide.
      slug: await uniqueV2PageSlug(tx, ctx.storeId, p.final_slug ?? m.slug),
      status: 'DRAFT',
      seo,
    },
    select: { id: true },
  });
  await tx.pageTranslation.create({
    data: {
      page_id: page.id,
      locale: ctx.primaryLocale,
      title: m.title,
      meta_title: m.meta_title,
      meta_description: m.meta_description,
    },
  });
  await writeSection(tx, ctx, page.id, m);
  await upsertLedger(tx, ctx, {
    entity_type: 'PAGE',
    external_ref: m.ref,
    target_id: page.id,
    source_hash: p.source_hash,
    applied_hash: pageStateHash(m),
    created: true,
    status: ImportEntityStatus.ACTIVE,
    payload: null,
  });
  return {
    entity_type: 'PAGE',
    external_ref: m.ref,
    action: 'CREATE',
    target_id: page.id,
    title: m.title,
  };
}

async function writeSection(
  tx: Tx,
  ctx: ApplyContext,
  pageId: string,
  m: MappedPage,
): Promise<void> {
  const section = await tx.pageSection.create({
    data: {
      page_id: pageId,
      section_key: IMPORTED_PAGE_SECTION_KEY,
      sort_order: 0,
      settings: { width: 'normal' },
    },
    select: { id: true },
  });
  await tx.pageSectionTranslation.create({
    data: {
      section_id: section.id,
      locale: ctx.primaryLocale,
      content: { html: m.html },
    },
  });
}
