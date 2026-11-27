/**
 * M175: the printed "c/o" line of a delivery address ("c/o Anna Berg").
 * Empty string when there is none. A value the shopper already typed with
 * its own "c/o" prefix is not prefixed twice.
 */
export function careOfLine(careOf: string | null | undefined): string {
  if (typeof careOf !== 'string') return '';
  const value = careOf
    .trim()
    .replace(/^c\s*\/\s*o\b[\s:.]*/i, '')
    .trim();
  return value ? `c/o ${value}` : '';
}
