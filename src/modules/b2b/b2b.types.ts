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
  /**
   * M2.5: remove VAT for a company with a VIES-valid EU VAT number buying
   * cross-border inside the EU (reverse charge). Off by default.
   */
  reverse_charge_enabled: boolean;
  /**
   * M2.5: what a reverse-charge company pays on an INCLUSIVE (gross-priced)
   * store. 'net' = the price without the registration-country VAT;
   * 'gross' = the unchanged price, treated entirely as net with VAT 0
   * (Shopify behaviour). EXCLUSIVE stores ignore it.
   */
  reverse_charge_pricing: ReverseChargePricing;
  /**
   * M2.5: VAT number sent to VIES as the requester (gives a consultation
   * number). Null = the seller VAT number of the invoices legal profile.
   * Never exposed to the storefront.
   */
  vies_requester_vat: string | null;
}

export type ReverseChargePricing = 'net' | 'gross';

export const REVERSE_CHARGE_PRICINGS: readonly ReverseChargePricing[] = [
  'net',
  'gross',
];

/** The single place the default reverse-charge pricing is decided. */
export const DEFAULT_REVERSE_CHARGE_PRICING: ReverseChargePricing = 'net';

export const DEFAULT_B2B_SETTINGS: B2bSettings = {
  allow_company: true,
  default_buyer_type: 'PERSON',
  require_vat_number: false,
  org_number_countries: ['SE'],
  reverse_charge_enabled: false,
  reverse_charge_pricing: DEFAULT_REVERSE_CHARGE_PRICING,
  vies_requester_vat: null,
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

// ── M2.5: EU reverse charge ────────────────────────────────────────────────

/** Why an order carries no VAT. Absent / null = taxed normally. */
export type TaxExemptReason = 'REVERSE_CHARGE' | 'CUSTOMER_EXEMPT';

/**
 * Outcome of a VAT-number check. `format_invalid` / `not_eu` never reach
 * VIES; `unavailable` covers every VIES failure (fail-closed: VAT charged).
 */
export type VatCheckStatus =
  | 'valid'
  | 'invalid'
  | 'unavailable'
  | 'format_invalid'
  | 'not_eu';

/** Kind of a merchant-granted customer exemption. */
export type TaxExemptionKind = 'REVERSE_CHARGE' | 'FULL';

/**
 * Evidence behind a reverse-charge decision, snapshotted on the order
 * (`Order.vat_validation`) and on a Kustom session.
 */
export interface VatEvidence {
  source: 'VIES' | 'MANUAL';
  /** Normalised, with the VIES prefix (EL for Greece, XI for N. Ireland). */
  vat_number: string;
  /** VIES member-state code (EL / XI kept). */
  country_code: string;
  status: VatCheckStatus;
  valid: boolean;
  name: string | null;
  address: string | null;
  /** VIES consultation number (only with a requester). */
  request_identifier: string | null;
  requester: string | null;
  /** ISO timestamp of the check. */
  checked_at: string;
  /** VatNumberCheck.id of the logged consultation. */
  check_id: string | null;
  error_code?: string | null;
  // Filled when bound to an order / session decision:
  seller_country?: string;
  destination_country?: string;
  vat_country_matches_destination?: boolean;
  exemption_id?: string;
  exemption_kind?: TaxExemptionKind;
  /** ISO timestamp the merchant granted the exemption (the note stays private). */
  exemption_created_at?: string;
}

/** Why no exemption applies (shown by the storefront next to the field). */
export type ReverseChargeWhy =
  | 'APP_OFF'
  | 'PERSON'
  | 'MARKETPLACE'
  | 'SELLER_NOT_EU'
  | 'DESTINATION_NOT_EU'
  | 'SAME_COUNTRY'
  | 'VAT_COUNTRY_IS_SELLER'
  | 'NO_VAT'
  | 'VAT_INVALID'
  | 'VAT_UNAVAILABLE'
  /** No shipping country yet (quote before the address step). */
  | 'NO_DESTINATION'
  /**
   * The order is VAT-free, but as a merchant-granted customer exemption,
   * not reverse charge (409 B2B_REVERSE_CHARGE_NOT_CONFIRMED only).
   */
  | 'CUSTOMER_EXEMPT';

/** Response of POST /storefront/:slug/b2b/vat-check. */
export interface VatCheckResponse {
  vat_number: string;
  country_code: string | null;
  /** 'disabled' = the app or reverse charge is off (no VIES call). */
  status: VatCheckStatus | 'disabled';
  name: string | null;
  checked_at: string | null;
  /** Null when no destination was given or reverse charge is off. */
  reverse_charge: boolean | null;
  why: ReverseChargeWhy | null;
}

/** `tax_exemption` block of a quote / Kustom session (b2b app only). */
export interface QuoteTaxExemption {
  reason: TaxExemptReason | null;
  vat_number: string | null;
  name: string | null;
  checked_at: string | null;
  why: ReverseChargeWhy | null;
}
