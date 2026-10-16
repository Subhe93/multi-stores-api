/**
 * Platform slug of a WordPress slug: WordPress stores non-ASCII slugs
 * percent-encoded; the platform stores them decoded (NFC, lower case).
 */
export function platformSlug(slug: string): string {
  let s = slug ?? '';
  try {
    s = decodeURIComponent(s);
  } catch {
    // An invalid escape keeps the slug as it is.
  }
  return s.normalize('NFC').toLowerCase().trim();
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
