import { isEuCountry } from '../taxes/tax-territory';
import type { TaxContext } from '../taxes/tax.service';
import type {
  B2bSettings,
  BuyerType,
  ReverseChargeWhy,
  TaxExemptReason,
  TaxExemptionKind,
  VatEvidence,
} from './b2b.types';
import { splitViesNumber, viesCountryToIso } from './vies/vies.parse';
import { validateVatNumber } from './vat-number.util';

// Reverse-charge decision of the b2b app (M2.5, D2). Pure: the inputs are
// loaded by B2bTaxExemptionService.prepare(), so the Kustom callbacks can
// re-run the identical decision from stored evidence without any I/O.

/** An active merchant-granted exemption of the buying customer. */
export interface CustomerExemptionRef {
  id: string;
  kind: TaxExemptionKind;
  vat_number: string | null;
  /** When the merchant granted it (the merchant's note is never loaded). */
  created_at?: Date | string | null;
}

/**
 * Everything the decision needs besides the order itself. Null (from
 * prepare) = the app or reverse charge is off: price exactly as before.
 */
export interface ExemptionInputs {
  settings: B2bSettings;
  /** VIES evidence of the buyer's VAT number (COMPANY with a number only). */
  vat: VatEvidence | null;
  customerExemption: CustomerExemptionRef | null;
}

export type TaxExemptionDecision =
  | { reason: TaxExemptReason; evidence: VatEvidence }
  | { reason: null; why: ReverseChargeWhy };

export interface DecideTaxExemptionInput {
  ctx: Pick<TaxContext, 'registrant' | 'taxCountry'>;
  /** Shipping country (ISO2); null = not known yet. */
  destinationCountry: string | null | undefined;
  buyerType: BuyerType;
  /** Null = the app or reverse charge is off. */
  inputs: ExemptionInputs | null;
}

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toUpperCase();
}

/** ISO country of a VAT number's prefix (EL becomes GR, XI kept). */
function vatIsoCountry(vat: string | null | undefined): string | null {
  const n = norm(vat);
  return n.length >= 2 ? viesCountryToIso(n.slice(0, 2)) : null;
}

/** Evidence of a merchant-granted exemption (no VIES consultation). */
function manualEvidence(
  ex: CustomerExemptionRef,
  vat: VatEvidence | null,
): VatEvidence {
  const number = ex.vat_number ?? vat?.vat_number ?? '';
  return {
    source: 'MANUAL',
    vat_number: number,
    country_code: number ? splitViesNumber(number).countryCode : '',
    // For MANUAL evidence `valid` records the merchant's decision.
    status: 'valid',
    valid: true,
    name: vat?.valid ? vat.name : null,
    address: null,
    request_identifier: null,
    requester: null,
    checked_at: new Date().toISOString(),
    check_id: null,
    exemption_id: ex.id,
    exemption_kind: ex.kind,
    ...(ex.created_at
      ? { exemption_created_at: new Date(ex.created_at).toISOString() }
      : {}),
  };
}

/**
 * Whether an order carries no VAT, and why (D2/D4). Order of the rules:
 * app / setting, FULL customer exemption (any destination), buyer type,
 * registrant, territory (seller EU, destination EU and foreign), manual
 * reverse-charge exemption, then the VIES result. Fail-closed: anything
 * short of a VALID number for a foreign member state keeps the VAT.
 */
export function decideTaxExemption(
  input: DecideTaxExemptionInput,
): TaxExemptionDecision {
  const { ctx, inputs } = input;
  if (!inputs || !inputs.settings.reverse_charge_enabled) {
    return { reason: null, why: 'APP_OFF' };
  }
  const exemption = inputs.customerExemption;
  if (ctx.registrant !== 'STORE') return { reason: null, why: 'MARKETPLACE' };
  if (exemption?.kind === 'FULL') {
    return {
      reason: 'CUSTOMER_EXEMPT',
      evidence: manualEvidence(exemption, inputs.vat),
    };
  }
  if (input.buyerType !== 'COMPANY') return { reason: null, why: 'PERSON' };

  const seller = norm(ctx.taxCountry);
  if (!seller || !isEuCountry(seller)) {
    return { reason: null, why: 'SELLER_NOT_EU' };
  }
  const destination = norm(input.destinationCountry);
  if (!destination) return { reason: null, why: 'NO_DESTINATION' };
  if (!isEuCountry(destination)) {
    return { reason: null, why: 'DESTINATION_NOT_EU' };
  }
  if (destination === seller) return { reason: null, why: 'SAME_COUNTRY' };

  const bind = (evidence: VatEvidence): VatEvidence => ({
    ...evidence,
    seller_country: seller,
    destination_country: destination,
    vat_country_matches_destination:
      vatIsoCountry(evidence.vat_number) === destination,
  });

  if (exemption?.kind === 'REVERSE_CHARGE' && exemption.vat_number) {
    if (vatIsoCountry(exemption.vat_number) === seller) {
      return { reason: null, why: 'VAT_COUNTRY_IS_SELLER' };
    }
    return {
      reason: 'REVERSE_CHARGE',
      evidence: bind(manualEvidence(exemption, inputs.vat)),
    };
  }

  const vat = inputs.vat;
  if (!vat || !vat.vat_number) return { reason: null, why: 'NO_VAT' };
  if (vat.status === 'unavailable') {
    return { reason: null, why: 'VAT_UNAVAILABLE' };
  }
  if (vat.status !== 'valid' || !vat.valid) {
    return { reason: null, why: 'VAT_INVALID' };
  }
  if (vatIsoCountry(vat.vat_number) === seller) {
    return { reason: null, why: 'VAT_COUNTRY_IS_SELLER' };
  }
  return { reason: 'REVERSE_CHARGE', evidence: bind(vat) };
}

/** The `why` of a VAT check that does not depend on a destination. */
export function whyOfVatStatus(
  status: VatEvidence['status'],
): ReverseChargeWhy | null {
  if (status === 'valid') return null;
  return status === 'unavailable' ? 'VAT_UNAVAILABLE' : 'VAT_INVALID';
}

/** The normalised VIES form (EL / XI prefix) of a format-valid number. */
export function viesFormOf(raw: string | null | undefined): string | null {
  const v = validateVatNumber(raw);
  if (!v.ok || !v.country) return null;
  const { countryCode, number } = splitViesNumber(v.normalized);
  return countryCode + number;
}

/** VatEvidence keys a customer may see on their own order. */
const CUSTOMER_EVIDENCE_KEYS = [
  'source',
  'vat_number',
  'country_code',
  'status',
  'valid',
  'name',
  'checked_at',
  'request_identifier',
  'seller_country',
  'destination_country',
  'vat_country_matches_destination',
  'exemption_kind',
  'exemption_created_at',
] as const;

/**
 * Customer-facing projection of Order.vat_validation: drops the internal
 * ids (check / exemption), the requester, the VIES address, error codes
 * and anything a merchant may have written (a legacy `note`). Non-objects
 * pass through unchanged (null stays null).
 */
export function customerVatEvidence(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value;
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of CUSTOMER_EVIDENCE_KEYS) if (k in src) out[k] = src[k];
  return out;
}
