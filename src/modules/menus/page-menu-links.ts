import { Logger } from '@nestjs/common';
import { MenuItemKind, Prisma } from '@prisma/client';

/*
 * Menu items of kind PAGE link a root page (v2 STATIC/LANDING or legacy
 * StaticPage, served at `/<slug>`) by id (`resource_id`) and also carry the
 * page URL in `url` (what the dashboard menu editor shows as "follows the
 * linked item"). When the page slug changes the stored URL would go stale:
 * the old-slug 301 would still land visitors on the page, but the header
 * should link the new URL directly. So the URL is rewritten on a slug change
 * (syncPageMenuLinks) and resolved again at serve time (rewritePageMenuItems)
 * for rows that drifted before this existed.
 */

/** Menu URL of a root page (same shape the dashboard menu editor stores). */
export function pageMenuUrl(slug: string): string {
  return `/${slug}`;
}

/**
 * `url` with its path replaced by the page URL; a `?query` / `#hash` the
 * item carries is kept.
 */
export function withPagePath(url: string | null, slug: string): string {
  const raw = url ?? '';
  const pathEnd = raw.search(/[?#]/);
  const suffix = pathEnd === -1 ? '' : raw.slice(pathEnd);
  return `${pageMenuUrl(slug)}${suffix}`;
}

/**
 * Menu items as served: a PAGE item whose page is known (`slugs` maps page
 * id -> current slug) gets that page's URL. Unknown pages keep the stored
 * URL (a deleted page is not dropped here: the stored link is all we have).
 */
export function rewritePageMenuItems<
  T extends { kind: string; resource_id: string | null; url: string | null },
>(items: T[], slugs: ReadonlyMap<string, string>): T[] {
  return items.map((it) => {
    if (it.kind !== MenuItemKind.PAGE || !it.resource_id) return it;
    const slug = slugs.get(it.resource_id);
    if (!slug) return it;
    const url = withPagePath(it.url, slug);
    return url === it.url ? it : { ...it, url };
  });
}

type MenuLinkDb = {
  menuItem: Pick<Prisma.TransactionClient['menuItem'], 'findMany' | 'update'>;
};

/**
 * Rewrites the stored URL of the store's PAGE menu items that link `pageId`
 * to the page's new slug. Returns how many rows changed (the caller then
 * refreshes the storefront cache that holds the menus).
 */
export async function syncPageMenuLinks(
  db: MenuLinkDb,
  storeId: string,
  pageId: string,
  slug: string,
): Promise<number> {
  const items = await db.menuItem.findMany({
    where: {
      kind: MenuItemKind.PAGE,
      resource_id: pageId,
      menu: { store_id: storeId },
    },
    select: { id: true, url: true },
  });
  let changed = 0;
  for (const it of items) {
    const url = withPagePath(it.url, slug);
    if (url === it.url) continue;
    await db.menuItem.update({ where: { id: it.id }, data: { url } });
    changed++;
  }
  return changed;
}

const logger = new Logger('PageMenuLinks');

/**
 * syncPageMenuLinks for a page edit: never throws (a failed relink must not
 * undo the merchant's slug change; the storefront still resolves the URL at
 * serve time). Returns 0 on failure.
 */
export async function relinkPageMenuItems(
  db: MenuLinkDb,
  storeId: string,
  pageId: string,
  slug: string,
): Promise<number> {
  try {
    return await syncPageMenuLinks(db, storeId, pageId, slug);
  } catch (err) {
    logger.error(
      `menu links of page ${pageId} (store ${storeId}) not updated: ${String(err)}`,
    );
    return 0;
  }
}
