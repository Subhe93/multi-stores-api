import { BadRequestException } from '@nestjs/common';

// M170 C: store-level merchant policies (`Store.merchant_policies`, jsonb):
// handling time and return policies. They feed the product page's structured
// data only (`shippingDetails.deliveryTime.handlingTime` and
// `hasMerchantReturnPolicy`) through the product shipping-rates read. Nothing
// is ever derived or defaulted: a store that configured nothing publishes
// nothing. Pure module (no Prisma, no Nest providers).

export type ReturnCategory = 'finite' | 'unlimited' | 'none';
export type ReturnMethod = 'mail' | 'store' | 'kiosk';
export type ReturnFees = 'free' | 'customer' | 'fixed';

export interface ReturnPolicy {
  /** ISO 3166-1 alpha-2, upper case, 1..50, each country in one policy only. */
  countries: string[];
  category: ReturnCategory;
  /** 1..365; only and always with 'finite'. */
  days?: number;
  /** 1..3 distinct values; never with 'none'. */
  methods?: ReturnMethod[];
  /** Never with 'none'. */
  fees?: ReturnFees;
  /**
   * > 0, two decimals; only and always with 'fixed'. Store base currency
   * (the currency shipping costs are stored in).
   */
  fee_amount?: number;
}

export interface MerchantPolicies {
  /** Business days between the order and the hand-over to the carrier. */
  handling?: { min_days: number; max_days: number };
  returns?: ReturnPolicy[];
  /**
   * M172: personalised products (the buyer enters a text, uploads an image
   * or designs the item, see storefront/personalised-product.ts) are
   * published as not returnable instead of with the policies above. Stored
   * only as `true` and only next to at least one return policy; absent =
   * off, so a store that never set it reads exactly as before.
   */
  personalized_no_returns?: true;
}

export const HANDLING_MAX_DAYS = 30;
export const RETURN_POLICIES_MAX = 10;
export const RETURN_COUNTRIES_MAX = 50;
export const RETURN_DAYS_MAX = 365;
export const RETURN_FEE_MAX = 1_000_000;

const CATEGORIES: readonly ReturnCategory[] = ['finite', 'unlimited', 'none'];
const METHODS: readonly ReturnMethod[] = ['mail', 'store', 'kiosk'];
const FEES: readonly ReturnFees[] = ['free', 'customer', 'fixed'];

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** null and undefined both mean "not given". */
function given(v: unknown): boolean {
  return v !== undefined && v !== null;
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** A finite number with at most two decimals. */
function isMoney(v: unknown): v is number {
  return (
    typeof v === 'number' &&
    Number.isFinite(v) &&
    Math.abs(Math.round(v * 100) - v * 100) < 1e-6
  );
}

function invalid(fields: string[]): BadRequestException {
  const unique = [...new Set(fields)];
  return new BadRequestException({
    code: 'MERCHANT_POLICIES_INVALID',
    message: `Invalid merchant policies: ${unique.join(', ')}`,
    fields: unique,
  });
}

/**
 * Validates a merchant-policies body and returns the normalised record
 * (countries upper-cased, keys in a fixed order, unknown keys dropped), or
 * `null` when nothing is configured (empty body, no handling and no return
 * policy), which the caller stores as SQL NULL.
 *
 * Throws 400 MERCHANT_POLICIES_INVALID with `fields`: paths such as
 * `handling.max_days`, `returns`, `returns.0.days`, `returns.1.countries`,
 * `personalized_no_returns`.
 */
export function validateMerchantPolicies(
  body: unknown,
): MerchantPolicies | null {
  if (!given(body)) return null;
  if (!isRecord(body)) throw invalid(['body']);
  const fields: string[] = [];

  // Handling time: both bounds or neither.
  let handling: MerchantPolicies['handling'];
  if (given(body.handling)) {
    if (!isRecord(body.handling)) {
      fields.push('handling.min_days', 'handling.max_days');
    } else {
      const min = body.handling.min_days;
      const max = body.handling.max_days;
      if (given(min) || given(max)) {
        const minOk = isInt(min) && min >= 0 && min <= HANDLING_MAX_DAYS;
        const maxOk = isInt(max) && max >= 0 && max <= HANDLING_MAX_DAYS;
        if (!minOk) fields.push('handling.min_days');
        if (!maxOk) fields.push('handling.max_days');
        if (minOk && maxOk) {
          if (min > max) fields.push('handling.max_days');
          else handling = { min_days: min, max_days: max };
        }
      }
    }
  }

  // Return policies.
  const returns: ReturnPolicy[] = [];
  if (given(body.returns)) {
    if (
      !Array.isArray(body.returns) ||
      body.returns.length > RETURN_POLICIES_MAX
    ) {
      fields.push('returns');
    } else {
      const taken = new Set<string>();
      body.returns.forEach((raw: unknown, i: number) => {
        const at = (key: string) => `returns.${i}.${key}`;
        if (!isRecord(raw)) {
          fields.push(at('countries'), at('category'));
          return;
        }

        // Countries: 1..50 ISO2 codes, distinct inside the policy and not
        // claimed by an earlier policy.
        const countries: string[] = [];
        let countriesOk =
          Array.isArray(raw.countries) &&
          raw.countries.length >= 1 &&
          raw.countries.length <= RETURN_COUNTRIES_MAX;
        if (countriesOk) {
          for (const c of raw.countries as unknown[]) {
            const code = typeof c === 'string' ? c.trim().toUpperCase() : '';
            if (
              !/^[A-Z]{2}$/.test(code) ||
              countries.includes(code) ||
              taken.has(code)
            ) {
              countriesOk = false;
              break;
            }
            countries.push(code);
          }
        }
        if (!countriesOk) fields.push(at('countries'));
        else for (const code of countries) taken.add(code);

        const category = raw.category as ReturnCategory;
        const categoryOk = CATEGORIES.includes(category);
        if (!categoryOk) fields.push(at('category'));

        // Days: only and always with a finite window.
        let days: number | undefined;
        if (category === 'finite') {
          if (isInt(raw.days) && raw.days >= 1 && raw.days <= RETURN_DAYS_MAX) {
            days = raw.days;
          } else {
            fields.push(at('days'));
          }
        } else if (categoryOk && given(raw.days)) {
          fields.push(at('days'));
        }

        // Methods: optional; an empty list means "not stated".
        let methods: ReturnMethod[] | undefined;
        if (given(raw.methods)) {
          if (!Array.isArray(raw.methods)) {
            fields.push(at('methods'));
          } else if (raw.methods.length > 0) {
            const list = raw.methods as ReturnMethod[];
            const ok =
              category !== 'none' &&
              list.every((m) => METHODS.includes(m)) &&
              new Set(list).size === list.length;
            if (!ok) fields.push(at('methods'));
            // Stored in the canonical order, whatever order was sent.
            else methods = METHODS.filter((m) => list.includes(m));
          }
        }

        // Fees + fixed fee amount.
        let fees: ReturnFees | undefined;
        if (given(raw.fees)) {
          if (category === 'none' || !FEES.includes(raw.fees as ReturnFees)) {
            fields.push(at('fees'));
          } else {
            fees = raw.fees as ReturnFees;
          }
        }
        let feeAmount: number | undefined;
        if (raw.fees === 'fixed' && category !== 'none') {
          if (
            isMoney(raw.fee_amount) &&
            raw.fee_amount > 0 &&
            raw.fee_amount <= RETURN_FEE_MAX
          ) {
            feeAmount = Math.round(raw.fee_amount * 100) / 100;
          } else {
            fields.push(at('fee_amount'));
          }
        } else if (given(raw.fee_amount)) {
          fields.push(at('fee_amount'));
        }

        returns.push({
          countries,
          category,
          ...(days !== undefined ? { days } : {}),
          ...(methods ? { methods } : {}),
          ...(fees ? { fees } : {}),
          ...(feeAmount !== undefined ? { fee_amount: feeAmount } : {}),
        });
      });
    }
  }

  // M172: strictly a boolean. `false` is the default and is not stored; the
  // flag says nothing without a return policy, so it is dropped (not
  // refused) when the list is empty.
  let personalizedNoReturns = false;
  if (given(body.personalized_no_returns)) {
    if (typeof body.personalized_no_returns !== 'boolean') {
      fields.push('personalized_no_returns');
    } else {
      personalizedNoReturns = body.personalized_no_returns;
    }
  }

  if (fields.length) throw invalid(fields);
  if (!handling && returns.length === 0) return null;
  return {
    ...(handling ? { handling } : {}),
    ...(returns.length ? { returns } : {}),
    ...(personalizedNoReturns && returns.length
      ? { personalized_no_returns: true as const }
      : {}),
  };
}

/**
 * Fail-closed reader of the stored column: anything that would not pass the
 * validator today (hand-edited, truncated, written by a future shape) reads
 * as "not configured", so a malformed value never reaches structured data.
 */
export function parseMerchantPolicies(raw: unknown): MerchantPolicies | null {
  if (!isRecord(raw)) return null;
  try {
    return validateMerchantPolicies(raw);
  } catch {
    return null;
  }
}

/** A return policy as the product shipping-rates read publishes it. */
export interface PublicReturnPolicy {
  /** Intersection with the requested countries, in request order. */
  countries: string[];
  category: ReturnCategory;
  days?: number;
  methods?: ReturnMethod[];
  fees?: ReturnFees;
  /** In the response currency (market-converted like shipping costs). */
  fee_amount?: number;
}

export interface PublicMerchantPolicies {
  handling_days?: { min: number; max: number };
  return_policies?: PublicReturnPolicy[];
}

/**
 * The public projection for one shipping-rates request: handling days as
 * stored, and the return policies that cover at least one requested country,
 * narrowed to those countries. A key is absent (never empty, never null) when
 * there is nothing to say, so an unconfigured store answers exactly as before.
 * `fromBase` converts a base-currency amount into the response currency;
 * null = no market, the amount is already in the response currency.
 *
 * M172: `personalised` says the product is made to the buyer's specification
 * (decided by the caller, storefront/personalised-product.ts). Together with
 * the store's `personalized_no_returns` flag, the covered countries are then
 * published as ONE policy of category 'none' (no days, methods or fees), in
 * request order. With the flag off, or for any other product, the output is
 * exactly the one above.
 */
export function publicMerchantPolicies(
  policies: MerchantPolicies | null,
  countries: readonly string[],
  fromBase: ((amount: number) => number) | null,
  personalised = false,
): PublicMerchantPolicies {
  if (!policies) return {};
  const out: PublicMerchantPolicies = {};
  if (policies.handling) {
    out.handling_days = {
      min: policies.handling.min_days,
      max: policies.handling.max_days,
    };
  }
  if (personalised && policies.personalized_no_returns === true) {
    const covered = countries.filter((c) =>
      (policies.returns ?? []).some((p) => p.countries.includes(c)),
    );
    if (covered.length) {
      out.return_policies = [{ countries: covered, category: 'none' }];
    }
    return out;
  }
  const list: PublicReturnPolicy[] = [];
  for (const policy of policies.returns ?? []) {
    const covered = countries.filter((c) => policy.countries.includes(c));
    if (covered.length === 0) continue;
    list.push({
      countries: covered,
      category: policy.category,
      ...(policy.days !== undefined ? { days: policy.days } : {}),
      ...(policy.methods ? { methods: [...policy.methods] } : {}),
      ...(policy.fees ? { fees: policy.fees } : {}),
      ...(policy.fee_amount !== undefined
        ? {
            fee_amount: fromBase
              ? fromBase(policy.fee_amount)
              : policy.fee_amount,
          }
        : {}),
    });
  }
  if (list.length) out.return_policies = list;
  return out;
}
