import type { Prisma } from '@prisma/client';

/**
 * Smart collections with `match_rule = TAGS` (tags rename, 2026-11-02).
 *
 * The `CreatorCategory.match_tags` column is kept (no migration) but its
 * values are now the ids of INTERNAL CreatorCategory rows ("tags") of the
 * same creator; the DTO / API field is `match_tag_ids`. A product or custom
 * product belongs to such a collection when it is linked
 * (ProductCreatorCategory / CustomProductCreatorCategory) to ANY of the
 * listed INTERNAL rows. An empty list matches nothing, like before.
 */

/** Own products linked to any of the INTERNAL rows. */
export function tagRuleProductWhere(
  tagIds: readonly string[],
): Prisma.ProductWhereInput {
  if (!tagIds.length) return { id: { in: [] } };
  return {
    creator_categories: {
      some: { creator_category_id: { in: [...tagIds] } },
    },
  };
}

/** Custom products linked (directly, not via the base product) to any row. */
export function tagRuleCustomProductWhere(
  tagIds: readonly string[],
): Prisma.CustomProductWhereInput {
  if (!tagIds.length) return { id: { in: [] } };
  return {
    creator_categories: {
      some: { creator_category_id: { in: [...tagIds] } },
    },
  };
}

/**
 * API shape of a collection row: `match_tag_ids` is the documented field;
 * `match_tags` is kept with the same values for one deploy window so an
 * older dashboard keeps working.
 */
export function withMatchTagIds<T extends { match_tags?: string[] | null }>(
  row: T,
): T & { match_tag_ids: string[] } {
  return { ...row, match_tag_ids: [...(row.match_tags ?? [])] };
}
