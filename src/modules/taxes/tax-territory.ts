/**
 * Tax territories. A registrant established in the EU taxes every EU
 * destination (its own rates below the OSS threshold, the destination's
 * rates once OSS-registered) and treats everything else as an export (0 %).
 * Outside the EU a registrant only taxes its own country.
 */
export const EU_COUNTRIES: readonly string[] = [
  'AT',
  'BE',
  'BG',
  'HR',
  'CY',
  'CZ',
  'DK',
  'EE',
  'FI',
  'FR',
  'DE',
  'GR',
  'HU',
  'IE',
  'IT',
  'LV',
  'LT',
  'LU',
  'MT',
  'NL',
  'PL',
  'PT',
  'RO',
  'SK',
  'SI',
  'ES',
  'SE',
];

const EU_SET = new Set(EU_COUNTRIES);

export function isEuCountry(country: string | null | undefined): boolean {
  return !!country && EU_SET.has(country.toUpperCase());
}

/** Two registrants share a territory when both are EU or both are the same country. */
export function sameTerritory(
  registration: string,
  destination: string,
): boolean {
  const reg = registration.toUpperCase();
  const dest = destination.toUpperCase();
  if (reg === dest) return true;
  return EU_SET.has(reg) && EU_SET.has(dest);
}
