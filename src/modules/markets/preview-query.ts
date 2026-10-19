/**
 * `?preview=1` of the storefront READ routes: set by the web app on a
 * market-preview host (`<slug>--<key>.<platform host>`), where a DRAFT
 * market is rendered before its domain is connected. Anything else (absent,
 * '0', 'true', ...) is not a preview, so existing requests are unchanged.
 */
export function isPreview(value: string | undefined | null): boolean {
  return value === '1';
}
