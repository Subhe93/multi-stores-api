/**
 * Store slugs a creator can never take (SPEC §1): they are (or may become)
 * platform hostnames / paths such as `api.<platform>` or `/admin`. Code
 * constant, no table.
 */
export const RESERVED_STORE_SLUGS: ReadonlySet<string> = new Set([
  'www',
  'api',
  'admin',
  'app',
  'dashboard',
  'mail',
  'smtp',
  'ftp',
  'static',
  'assets',
  'cdn',
  'images',
  'img',
  'media',
  'files',
  'blog',
  'shop',
  'store',
  'stores',
  'support',
  'help',
  'docs',
  'status',
  'login',
  'auth',
  'account',
  'accounts',
  'checkout',
  'cart',
  'ms-api',
  'ms-dash',
  'platform',
  'shopsdoor',
  'namez',
]);

export function isReservedStoreSlug(slug: string): boolean {
  return RESERVED_STORE_SLUGS.has(slug.trim().toLowerCase());
}
