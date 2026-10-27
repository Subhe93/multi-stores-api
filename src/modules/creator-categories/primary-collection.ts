import { BadRequestException } from '@nestjs/common';

/**
 * M6: which linked collection is the product's primary one (breadcrumb and
 * feed category path).
 *
 * - `requested` (a collection id) must be one of `linked`, otherwise
 *   `PRIMARY_COLLECTION_NOT_LINKED`; it must not be INTERNAL (M6.3),
 *   otherwise `PRIMARY_COLLECTION_INTERNAL`.
 * - `requested` null/absent: the `current` primary when still linked and
 *   PUBLIC, else the first PUBLIC link of `linked`.
 * - no PUBLIC links → null (a requested id is then an error too).
 *
 * `linked` is in the order the editor sent the collections (or the stored
 * link order), which is what "first of the list" means. `internal` lists
 * the ids among `linked` whose visibility is INTERNAL (labels can be linked
 * but are never the primary).
 */
export function resolvePrimaryCreatorCategory(args: {
  requested: string | null | undefined;
  linked: string[];
  current: string | null;
  internal?: Iterable<string>;
}): string | null {
  const { requested, linked, current } = args;
  const internal = new Set(args.internal ?? []);
  if (requested) {
    if (!linked.includes(requested)) {
      throw new BadRequestException({
        code: 'PRIMARY_COLLECTION_NOT_LINKED',
        message: 'The primary collection must be one of the linked collections',
      });
    }
    if (internal.has(requested)) {
      throw new BadRequestException({
        code: 'PRIMARY_COLLECTION_INTERNAL',
        message: 'An internal label cannot be the primary collection',
      });
    }
    return requested;
  }
  const candidates = linked.filter((id) => !internal.has(id));
  if (candidates.length === 0) return null;
  if (current && candidates.includes(current)) return current;
  return candidates[0];
}

/** Max tree depth of creator collections: root = 0, grandchild = 2. */
export const CREATOR_CATEGORY_MAX_DEPTH = 2;

/** Max nesting of menu items: top level = 1, so three levels in all. */
export const MENU_MAX_DEPTH = 3;

/**
 * M6.3: a product's collection links as the product services hand them to
 * resolvePrimaryCreatorCategory: every linked id in order, plus the subset
 * whose visibility is INTERNAL.
 */
export interface CreatorCategoryLinks {
  linked: string[];
  internal: string[];
}
