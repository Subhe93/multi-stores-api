// Mirror of multi-stores-shared/src/types/b2b.ts — keep in sync.

// B2B app (M2): buyer type as a request-level signal, the app's settings and
// the company snapshot an order carries.

/** Who is buying. Null / absent on a row means PERSON (pre-app behaviour). */
export type BuyerType = 'PERSON' | 'COMPANY';

export const BUYER_TYPES: readonly BuyerType[] = ['PERSON', 'COMPANY'];

/**
 * StoreApp.settings of the b2b app. Every field is optional on the wire;
 * readers merge the defaults (allow_company true, default PERSON, VAT number
 * optional, strict organisation-number format for SE only).
 */
export interface B2bSettings {
  /** Shoppers may switch to "company" (false hides the toggle). */
  allow_company: boolean;
  /** Buyer type a storefront starts in when the visitor has no cookie. */
  default_buyer_type: BuyerType;
  /** A company order must carry a VAT number. */
  require_vat_number: boolean;
  /**
   * ISO2 countries whose organisation-number format is validated strictly
   * (SE, FI, DK, NO have rules); every other country uses the generic rule.
   */
  org_number_countries: string[];
}

export const DEFAULT_B2B_SETTINGS: B2bSettings = {
  allow_company: true,
  default_buyer_type: 'PERSON',
  require_vat_number: false,
  org_number_countries: ['SE'],
};

/** What a company checkout sends (`company` in the order / session body). */
export interface CompanyInput {
  company_name: string;
  org_number: string;
  vat_number?: string | null;
  buyer_reference?: string | null;
}

/**
 * The company snapshot stored on an order (and on a Kustom session). All
 * null on an order placed as a person.
 */
export interface CompanySnapshot {
  customer_type: BuyerType;
  company_name: string;
  org_number: string;
  vat_number: string | null;
  buyer_reference: string | null;
}

/**
 * The `b2b` block of cart / quote / session / order-create responses,
 * present only when the b2b app is enabled for the store. Amounts are the
 * same money as the gross totals, split out for the company view: nets are
 * derived from the tax engine (net_total = total - tax_total).
 */
export interface B2bTotals {
  /** How prices are presented: excl. for companies and EXCLUSIVE stores. */
  display_mode: 'incl' | 'excl';
  /** Sum of line nets after the discount share. */
  net_items: number;
  net_shipping: number;
  /** total - tax_total (= net_items + net_shipping). */
  net_total: number;
}
