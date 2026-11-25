import { BadRequestException } from '@nestjs/common';
import { Prisma, type PrismaClient } from '@prisma/client';

/**
 * M170 A: alt text of a product image per locale.
 *
 * `ProductImage.alt_text` stays the default alt (the store primary language);
 * `ProductImage.alt_translations` holds the other locales as
 * `{ "<locale>": "<alt>" }`. The map travels with the image row (rows are
 * deleted and recreated on every product save, so nothing is keyed by id).
 *
 * The storefront keeps the read side (fallback chain) in
 * multi-stores-web/src/lib/imageAlt.ts.
 */

export const IMAGE_ALT_MAX = 300;
export const IMAGE_ALT_MAX_LOCALES = 20;

export type ImageAltTranslations = Record<string, string>;

/** Same locale shape the product DTOs accept (`de`, `de-AT`). */
const LOCALE_KEY = /^[a-z]{2}(-[A-Z]{2})?$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function invalid(message: string): never {
  throw new BadRequestException({
    code: 'PRODUCT_IMAGE_ALT_INVALID',
    message,
    fields: ['images'],
  });
}

/**
 * Validates and normalises a client-sent map. Values are trimmed with inner
 * whitespace collapsed, empty values are dropped, and the store primary
 * locale key is dropped (`alt_text` is the only source for that locale, so
 * the map can never shadow the default alt). An empty result is `null`.
 * Throws a coded 400 on a non-object, a bad locale key, a non-string value,
 * a value over IMAGE_ALT_MAX or more than IMAGE_ALT_MAX_LOCALES keys.
 */
export function normalizeAltTranslations(
  input: unknown,
  primaryLocale: string,
): ImageAltTranslations | null {
  if (input === null || input === undefined) return null;
  if (!isPlainObject(input)) {
    invalid('Image alt translations must be an object of locale -> text.');
  }
  const keys = Object.keys(input);
  if (keys.length > IMAGE_ALT_MAX_LOCALES) {
    invalid(
      `An image can have alt text in at most ${IMAGE_ALT_MAX_LOCALES} languages.`,
    );
  }
  const out: ImageAltTranslations = {};
  for (const key of keys) {
    if (!LOCALE_KEY.test(key)) {
      invalid('Image alt translations contain an invalid language code.');
    }
    const raw = input[key];
    if (typeof raw !== 'string') {
      invalid('Image alt text must be text.');
    }
    const value = raw.replace(/\s+/g, ' ').trim();
    if (value.length > IMAGE_ALT_MAX) {
      invalid(`Image alt text can be at most ${IMAGE_ALT_MAX} characters.`);
    }
    if (!value) continue;
    if (key === primaryLocale) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Defensive parse of the stored column: keeps string values only, `null`
 * when nothing is left. Never throws (stored data is not re-validated).
 */
export function readAltTranslations(raw: unknown): ImageAltTranslations | null {
  if (!isPlainObject(raw)) return null;
  const out: ImageAltTranslations = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === 'string' && value) out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * The map to store for each image of a product save, aligned with `images`:
 *   - `alt_translations` undefined: the stored map of the row with the same
 *     url is carried over (an older dashboard never wipes localized alts);
 *     no stored row with that url -> null;
 *   - null / {}: cleared;
 *   - object: validated and normalised.
 * Runs before any write, so an invalid map fails the save as a whole.
 */
export function prepareImageAltTranslations(
  images: readonly { url: string; alt_translations?: unknown }[],
  stored: readonly { url: string; alt_translations?: unknown }[],
  primaryLocale: string,
): (ImageAltTranslations | null)[] {
  const storedByUrl = new Map<string, ImageAltTranslations | null>();
  for (const row of stored) {
    // First row wins when a gallery holds the same url twice.
    if (!storedByUrl.has(row.url)) {
      storedByUrl.set(row.url, readAltTranslations(row.alt_translations));
    }
  }
  return images.map((img) =>
    img.alt_translations === undefined
      ? (storedByUrl.get(img.url) ?? null)
      : normalizeAltTranslations(img.alt_translations, primaryLocale),
  );
}

/**
 * The row after the store primary language changed from `oldPrimary` to
 * `newPrimary`, or `null` when the row stays as it is.
 *
 * `alt_text` is by definition the alt of the primary language, so an image
 * that has an alt for the new primary language gets it promoted to
 * `alt_text`, and the previous `alt_text` moves into the map under the old
 * primary language (unless the map already has that key). An image without
 * an alt for the new primary language is left alone: its `alt_text` keeps
 * serving as the default alt of every language.
 */
export function swapPrimaryAlt(
  row: { alt_text?: string | null; alt_translations?: unknown },
  oldPrimary: string,
  newPrimary: string,
): { alt_text: string; alt_translations: ImageAltTranslations | null } | null {
  if (oldPrimary === newPrimary) return null;
  const map = readAltTranslations(row.alt_translations) ?? {};
  const promoted = (map[newPrimary] ?? '').replace(/\s+/g, ' ').trim();
  if (!promoted) return null;
  delete map[newPrimary];
  const previous = (row.alt_text ?? '').replace(/\s+/g, ' ').trim();
  if (previous && !map[oldPrimary] && LOCALE_KEY.test(oldPrimary)) {
    // `alt_text` has no length limit of its own; a map value has.
    map[oldPrimary] = previous.slice(0, IMAGE_ALT_MAX);
  }
  return {
    alt_text: promoted,
    alt_translations: Object.keys(map).length > 0 ? map : null,
  };
}

/**
 * Applies `swapPrimaryAlt` to the product images of a store that carry
 * localized alts (the only rows the rule can change), in one transaction.
 * Called by every writer of `StoreLanguageConfig.primary_locale` right after
 * the primary language changed.
 */
export async function swapStoreImageAltsForPrimary(
  db: Pick<PrismaClient, 'productImage' | '$transaction'>,
  storeId: string,
  oldPrimary: string,
  newPrimary: string,
): Promise<number> {
  if (oldPrimary === newPrimary) return 0;
  const rows = await db.productImage.findMany({
    where: {
      product: { creator: { store: { id: storeId } } },
      alt_translations: { not: Prisma.DbNull },
    },
    select: {
      id: true,
      alt_text: true,
      alt_translations: true,
    } satisfies Prisma.ProductImageSelect,
  });
  const updates = rows.flatMap((row) => {
    const next = swapPrimaryAlt(row, oldPrimary, newPrimary);
    return next
      ? [
          db.productImage.update({
            where: { id: row.id },
            data: {
              alt_text: next.alt_text,
              alt_translations: altTranslationsColumn(next.alt_translations),
            },
          }),
        ]
      : [];
  });
  if (updates.length) await db.$transaction(updates);
  return updates.length;
}

/** Maps "no map" to SQL NULL for the nullable Json column (mirror of labelsColumn). */
export function altTranslationsColumn(
  map: ImageAltTranslations | null | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return map && Object.keys(map).length > 0
    ? (map as Prisma.InputJsonValue)
    : Prisma.DbNull;
}

/**
 * Public wire shape of an image row read with the column opted in: the key
 * is removed when the image has no localized alt, so such images serialize
 * exactly as before M170.
 */
export function publicImage<T extends { alt_translations?: unknown }>(
  row: T,
): Omit<T, 'alt_translations'> & { alt_translations?: ImageAltTranslations } {
  const { alt_translations, ...rest } = row;
  const map = readAltTranslations(alt_translations);
  return map ? { ...rest, alt_translations: map } : rest;
}
