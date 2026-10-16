import { Prisma } from '@prisma/client';
import { isPlainObject, lineKey, type NormalizedValues } from './rules';

/**
 * Cart line identity (M4.0 §1.2, C11). Two cart rows of the same product,
 * variant, custom product and bundle merge only when their personalization
 * has the same `lineKey`. Both sides drop keys that are not fields of the
 * product, so a legacy row with unnormalized JSON (`"Anna "`, `{}` vs `null`)
 * still matches a new add of the same values.
 */

/** Keeps only the keys that are field ids of the product. */
export function filterKnownFields(
  customFields: unknown,
  fieldIds: ReadonlySet<string>,
): Record<string, unknown> {
  if (!isPlainObject(customFields)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(customFields)) {
    if (fieldIds.has(k)) out[k] = v;
  }
  return out;
}

/** The line key of a stored cart row against the product's current fields. */
export function cartRowLineKey(
  customFields: unknown,
  fieldIds: ReadonlySet<string>,
  designId?: string | null,
): string {
  return lineKey(filterKnownFields(customFields, fieldIds), designId);
}

/**
 * What a new cart row stores in `custom_fields` (G0):
 *  - a product without fields (`hasFields` false): exactly what was sent, as
 *    before M4.0 (`null` becomes `Prisma.DbNull`);
 *  - validated values when there are any;
 *  - otherwise exactly what was sent when it was `undefined` or `{}`
 *    (`AddToCartMagic` sends `{}` and `GET /cart` echoes it back);
 *  - `null` becomes `Prisma.DbNull` (a JSON column refuses a bare null);
 *  - anything else (stale keys only, non-objects) is not stored (DbNull).
 */
export function storedCustomFields(
  sent: unknown,
  normalized: NormalizedValues,
  hasFields = true,
): Prisma.InputJsonValue | typeof Prisma.DbNull | undefined {
  if (!hasFields) {
    if (sent === undefined) return undefined;
    return sent === null ? Prisma.DbNull : (sent as Prisma.InputJsonValue);
  }
  if (Object.keys(normalized).length > 0) {
    return normalized as Prisma.InputJsonValue;
  }
  if (sent === undefined) return undefined;
  if (isPlainObject(sent) && Object.keys(sent).length === 0) {
    return sent as Prisma.InputJsonValue;
  }
  return Prisma.DbNull;
}
