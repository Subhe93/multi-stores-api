/**
 * Title translation row for a locale (M160): the exact locale, then the base
 * language (`de-AT` → `de`), then the store's canonical language
 * (`language_config.primary_locale` of the STORE, never a market default
 * locale), then English, then the first row.
 *
 * Used for product / custom product titles shown in carts. The shared
 * `pickTranslation` (custom-field labels, snapshots) keeps its own chain.
 */
export function pickTitleTranslation<T extends { locale: string }>(
  rows: readonly T[] | null | undefined,
  locale?: string | null,
  canonicalLocale?: string | null,
): T | undefined {
  if (!rows?.length) return undefined;
  const lower = (s: string) => s.toLowerCase();
  const base = (s: string) => lower(s).split(/[-_]/)[0] ?? '';
  const byExact = (l: string) => rows.find((r) => lower(r.locale) === lower(l));
  const byBase = (l: string) => {
    const b = base(l);
    if (!b) return undefined;
    return (
      rows.find((r) => lower(r.locale) === b) ||
      rows.find((r) => base(r.locale) === b)
    );
  };
  return (
    (locale ? byExact(locale) || byBase(locale) : undefined) ||
    (canonicalLocale
      ? byExact(canonicalLocale) || byBase(canonicalLocale)
      : undefined) ||
    byExact('en') ||
    rows[0]
  );
}
