import { sanitizeTitle } from '@multi-stores/core/slug';
import { isReservedStoreSlug } from '../../common/slug/reserved-store-slugs';

/**
 * Store slug rules shared by `POST /stores` (CreateStoreDto) and the
 * availability check: a DNS label of 2–50 lowercase ASCII letters, digits
 * and hyphens, no leading/trailing hyphen.
 */
export const STORE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const STORE_SLUG_MIN = 2;
export const STORE_SLUG_MAX = 50;

export type SlugUnavailableReason = 'taken' | 'reserved' | 'invalid';

/** Answer of `GET /stores/slug-available?slug=`. */
export interface SlugAvailability {
  /** The slug as sent. */
  slug: string;
  /** What the WP slug rule makes of it (what the form should submit). */
  normalized: string;
  available: boolean;
  reason?: SlugUnavailableReason;
}

/**
 * Normalises a typed slug with the WP rule (`sanitizeTitle`, English site
 * locale: accents stripped, spaces → hyphens) and then keeps only what a
 * hostname label allows. Non-Latin input percent-encodes under WP and is
 * dropped here, so it ends up `invalid` instead of silently changed.
 */
export function normalizeStoreSlug(raw: string): string {
  const wp = sanitizeTitle(String(raw ?? '').trim(), { locale: 'en' });
  return wp
    .toLowerCase()
    .replace(/%[0-9a-f]{2}/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Whether a normalised slug satisfies the pattern and length rules. */
export function isValidStoreSlug(normalized: string): boolean {
  return (
    normalized.length >= STORE_SLUG_MIN &&
    normalized.length <= STORE_SLUG_MAX &&
    STORE_SLUG_PATTERN.test(normalized)
  );
}

/**
 * The local part of the availability answer (no DB): `invalid` or
 * `reserved`, else null meaning "ask the database whether it is taken".
 */
export function localSlugVerdict(
  normalized: string,
): Exclude<SlugUnavailableReason, 'taken'> | null {
  if (!isValidStoreSlug(normalized)) return 'invalid';
  if (isReservedStoreSlug(normalized)) return 'reserved';
  return null;
}
