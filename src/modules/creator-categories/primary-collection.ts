import { BadRequestException } from '@nestjs/common';

/**
 * M6: which linked collection is the product's primary one (breadcrumb and
 * feed category path).
 *
 * - `requested` (a collection id) must be one of `linked`, otherwise
 *   `PRIMARY_COLLECTION_NOT_LINKED`.
 * - `requested` null/absent: exactly one link → that one; several → the
 *   `current` primary when still linked, else the first of `linked`.
 * - no links → null (a requested id is then an error too).
 *
 * `linked` is in the order the editor sent the collections (or the stored
 * link order), which is what "first of the list" means.
 */
export function resolvePrimaryCreatorCategory(args: {
  requested: string | null | undefined;
  linked: string[];
  current: string | null;
}): string | null {
  const { requested, linked, current } = args;
  if (requested) {
    if (!linked.includes(requested)) {
      throw new BadRequestException({
        code: 'PRIMARY_COLLECTION_NOT_LINKED',
        message: 'The primary collection must be one of the linked collections',
      });
    }
    return requested;
  }
  if (linked.length === 0) return null;
  if (linked.length === 1) return linked[0];
  if (current && linked.includes(current)) return current;
  return linked[0];
}

/** Max tree depth of creator collections: root = 0, grandchild = 2. */
export const CREATOR_CATEGORY_MAX_DEPTH = 2;

/** Max nesting of menu items: top level = 1, so three levels in all. */
export const MENU_MAX_DEPTH = 3;
