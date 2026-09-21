/**
 * Default platform tax classes and rates (API-CONTRACT-TAX.md §3). Applied by
 * `POST /taxes/admin/rates/seed`, which is idempotent: classes are upserted
 * by key and a platform rate that already exists for (class, country, no
 * region, no postcode) is updated in place, never duplicated. Rates are
 * basis points (2500 = 25 %).
 */

export type SeedClassKey = 'standard' | 'reduced' | 'super_reduced' | 'zero';

export const TAX_LABEL: Record<string, string> = {
  en: 'VAT',
  sv: 'Moms',
  de: 'MwSt.',
  fr: 'TVA',
  tr: 'KDV',
  ar: 'ضريبة القيمة المضافة',
};

export const SEED_CLASSES: {
  key: SeedClassKey;
  name: Record<string, string>;
  is_default: boolean;
  sort_order: number;
}[] = [
  {
    key: 'standard',
    name: {
      en: 'Standard',
      sv: 'Standard',
      de: 'Standard',
      fr: 'Standard',
      tr: 'Standart',
      ar: 'قياسية',
    },
    is_default: true,
    sort_order: 0,
  },
  {
    key: 'reduced',
    name: {
      en: 'Reduced',
      sv: 'Reducerad',
      de: 'Ermäßigt',
      fr: 'Réduit',
      tr: 'İndirimli',
      ar: 'مخفضة',
    },
    is_default: false,
    sort_order: 1,
  },
  {
    // Third rate of the countries that have one (SE 6 %, FR 5.5 %, ...).
    key: 'super_reduced',
    name: {
      en: 'Super reduced',
      sv: 'Extra reducerad',
      de: 'Stark ermäßigt',
      fr: 'Super réduit',
      tr: 'Çok indirimli',
      ar: 'مخفضة جداً',
    },
    is_default: false,
    sort_order: 2,
  },
  {
    key: 'zero',
    name: {
      en: 'Zero',
      sv: 'Noll',
      de: 'Null',
      fr: 'Zéro',
      tr: 'Sıfır',
      ar: 'صفرية',
    },
    is_default: false,
    sort_order: 3,
  },
];

/** [country, standard, reduced?, super_reduced?] in basis points. */
type SeedRow = [string, number, number?, number?];

export const SEED_RATES: SeedRow[] = [
  // EU
  ['SE', 2500, 1200, 600],
  ['DK', 2500],
  ['FI', 2550, 1400, 1000],
  ['DE', 1900, 700],
  ['FR', 2000, 1000, 550],
  ['NL', 2100, 900],
  ['AT', 2000, 1000],
  ['BE', 2100, 600],
  ['PL', 2300, 800, 500],
  ['ES', 2100, 1000, 400],
  ['IT', 2200, 1000, 500],
  ['IE', 2300, 1350, 900],
  ['PT', 2300, 1300, 600],
  ['LU', 1700, 800, 300],
  ['CZ', 2100, 1200],
  ['HU', 2700, 1800, 500],
  ['RO', 1900, 900, 500],
  ['BG', 2000, 900],
  ['HR', 2500, 1300, 500],
  ['SI', 2200, 950],
  ['SK', 2300, 1900, 500],
  ['EE', 2400, 1300, 900],
  ['LV', 2100, 1200, 500],
  ['LT', 2100, 900, 500],
  ['GR', 2400, 1300, 600],
  ['CY', 1900, 900, 500],
  ['MT', 1800, 700, 500],
  // Europe outside the EU
  ['GB', 2000, 500, 0],
  ['CH', 810, 260],
  ['NO', 2500, 1500, 1200],
  ['TR', 2000, 1000, 100],
  // GCC and neighbours
  ['AE', 500],
  ['SA', 1500],
  ['BH', 1000],
  ['OM', 500],
  ['QA', 0],
  ['KW', 0],
  ['EG', 1400],
  ['JO', 1600],
];

export interface SeedRate {
  class_key: SeedClassKey;
  country: string;
  rate_bp: number;
}

/** One row per (class, country) of the table above. */
export function flattenSeedRates(): SeedRate[] {
  const out: SeedRate[] = [];
  for (const [country, standard, reduced, superReduced] of SEED_RATES) {
    out.push({ class_key: 'standard', country, rate_bp: standard });
    if (reduced !== undefined) {
      out.push({ class_key: 'reduced', country, rate_bp: reduced });
    }
    if (superReduced !== undefined) {
      out.push({ class_key: 'super_reduced', country, rate_bp: superReduced });
    }
  }
  return out;
}
