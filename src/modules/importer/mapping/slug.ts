import { encodeSlugForUrl, sanitizeTitle } from '@multi-stores/core/slug';

/**
 * Platform slug of a WordPress slug. WordPress stores non-ASCII slugs
 * percent-encoded (`kl%c3%a4der`); the platform stores them decoded (NFC,
 * lower case) and runs every slug through the same WP sanitize_title port as
 * the rest of the API. The decoded value is first put back in WP's own
 * encoded form, so the sanitizer keeps what WP kept (`kläder`, `مرحبا`)
 * instead of folding accents of an already-saved slug. `fallback` (WP's id
 * fallback, e.g. `product-<source id>`) is used when nothing remains.
 */
export function platformSlug(slug: string, fallback = ''): string {
  let s = slug ?? '';
  try {
    s = decodeURIComponent(s);
  } catch {
    // An invalid escape keeps the slug as it is; the sanitizer drops the '%'.
  }
  return sanitizeTitle(encodeSlugForUrl(s.normalize('NFC'))) || fallback;
}

/** `slug`, `slug-2`, `slug-3`, … — the first one `isTaken` accepts. */
export function firstFreeSlug(
  desired: string,
  isTaken: (slug: string) => boolean,
  limit = 1000,
): { slug: string; suffixed: boolean } {
  if (!isTaken(desired)) return { slug: desired, suffixed: false };
  for (let n = 2; n <= limit; n++) {
    const s = `${desired}-${n}`;
    if (!isTaken(s)) return { slug: s, suffixed: true };
  }
  return { slug: `${desired}-${Date.now().toString(36)}`, suffixed: true };
}
