import { Prisma } from '@prisma/client';
import { dropHiddenSubtrees, orderSectionsAsTree } from './section-tree';

/**
 * Canonical read order of a page's sections, used by every query whose
 * result is turned into the builder list, a snapshot or a placement
 * (getById, listSections, publish, restore points, duplicate, convert).
 * `sort_order` alone leaves ties in whatever order Postgres returns them,
 * which can change after an unrelated update of a tied row; created_at then
 * id make the order of tied siblings stable and identical everywhere.
 * orderSectionsAsTree keeps this order for ties (stable sort).
 */
export const SECTION_READ_ORDER: Prisma.PageSectionOrderByWithRelationInput[] = [
  { sort_order: 'asc' },
  { created_at: 'asc' },
  { id: 'asc' },
];

/** A page with the rows a snapshot is built from. */
export type SnapshotSourcePage = Prisma.PageGetPayload<{
  include: {
    translations: true;
    sections: { include: { translations: true } };
  };
}>;

export interface SnapshotSectionEntry {
  id: string;
  parent_id: string | null;
  section_key: string;
  settings: Prisma.JsonValue;
  sort_order: number;
  /** Only on restore points (drafts); publish snapshots drop hidden rows. */
  is_hidden?: boolean;
  translations: { locale: string; content: Prisma.JsonValue }[];
}

/**
 * Snapshot of a page (SEO/translations + sections + per-locale content).
 *
 * The section array stays flat; each entry carries its `parent_id` and
 * entries are in depth-first tree order (for a page without containers this
 * is plain sort_order order).
 *
 * - `mode: 'publish'`: hidden sections and all their descendants are left
 *   out so the storefront never renders them.
 * - `mode: 'draft'`: a restore point; every section is kept, with its
 *   `is_hidden` flag, so restoreVersion rebuilds the exact working draft.
 */
export function buildPageSnapshot(
  page: SnapshotSourcePage,
  mode: 'publish' | 'draft',
) {
  const rows =
    mode === 'publish' ? dropHiddenSubtrees(page.sections) : page.sections;
  const sections: SnapshotSectionEntry[] = orderSectionsAsTree(rows).map(
    (s) => ({
      id: s.id,
      parent_id: s.parent_id ?? null,
      section_key: s.section_key,
      settings: s.settings,
      sort_order: s.sort_order,
      ...(mode === 'draft' ? { is_hidden: s.is_hidden } : {}),
      translations: s.translations.map((t) => ({
        locale: t.locale,
        content: t.content,
      })),
    }),
  );
  return {
    page: {
      type: page.type,
      static_kind: page.static_kind,
      slug: page.slug,
      seo: page.seo,
      translations: page.translations,
    },
    sections,
  };
}

/**
 * Writes an unpublished PageVersion restore point of the page's current
 * draft. No-op (returns false) for a missing page or one without sections.
 * Used before destructive replaces (kit import, theme chrome apply).
 */
export async function writeRestorePoint(
  tx: Prisma.TransactionClient,
  pageId: string,
  label: string,
): Promise<boolean> {
  const page = await tx.page.findUnique({
    where: { id: pageId },
    include: {
      translations: true,
      sections: {
        include: { translations: true },
        orderBy: SECTION_READ_ORDER,
      },
    },
  });
  if (!page || page.sections.length === 0) return false;
  await tx.pageVersion.create({
    data: {
      page_id: pageId,
      label,
      snapshot: buildPageSnapshot(
        page,
        'draft',
      ) as unknown as Prisma.InputJsonValue,
      published_at: null,
    },
  });
  return true;
}
