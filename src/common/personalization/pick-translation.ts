/**
 * Picks the translation row for a locale: the exact locale, then English,
 * then the first row. Shared by the cart display, the personalization error
 * labels and the snapshot reader so they can never disagree.
 */
export function pickTranslation<T extends { locale: string }>(
  translations: readonly T[] | null | undefined,
  locale?: string | null,
): T | undefined {
  if (!translations?.length) return undefined;
  return (
    (locale ? translations.find((t) => t.locale === locale) : undefined) ||
    translations.find((t) => t.locale === 'en') ||
    translations[0]
  );
}
