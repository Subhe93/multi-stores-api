import { Prisma } from '@prisma/client';
import type { VariantOptionLabels } from './variant-option-labels';

/**
 * M159: maps "no labels" to SQL NULL for a nullable Json column write (a plain
 * `null` is rejected by Prisma for Json inputs). Kept apart so the pure
 * module stays Prisma-free.
 */
export function labelsColumn(
  labels: VariantOptionLabels | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return labels ? (labels as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
}
