import { BadRequestException, Injectable } from '@nestjs/common';
import { StoreAppsService } from '../store-apps/store-apps.service';
import {
  type B2bSettings,
  type BuyerType,
  type CompanyInput,
  type CompanySnapshot,
} from './b2b.types';
import { parseB2bSettings } from './b2b-settings';
import { validateOrgNumber } from './org-number.util';
import { validateVatNumber } from './vat-number.util';

/** Customer kinds a Kustom checkout may offer (Klarna Checkout v3 naming). */
export type KustomCustomerType = 'person' | 'organization';

export interface B2bError {
  code:
    | 'B2B_COMPANY_NAME_REQUIRED'
    | 'B2B_ORG_NUMBER_REQUIRED'
    | 'B2B_ORG_NUMBER_INVALID'
    | 'B2B_VAT_NUMBER_REQUIRED'
    | 'B2B_VAT_NUMBER_INVALID';
  message: string;
}

/** 400 for a COMPANY request the store does not accept (app off / disallowed). */
export const B2B_COMPANY_NOT_ALLOWED = {
  code: 'B2B_COMPANY_NOT_ALLOWED',
  message: 'This store does not accept company purchases.',
};

/**
 * B2B app (M2). Buyer type is a request-level signal (D1): the storefront
 * asks for COMPANY and this service grants it only while the app is in
 * effect for the store and its settings allow company purchases; otherwise
 * every path runs exactly as for a person. The company data of an order is
 * validated here (format only, D7) and written as a snapshot by the caller.
 */
@Injectable()
export class B2bService {
  constructor(private readonly storeApps: StoreAppsService) {}

  /** Whether the b2b app is in effect for the store (cached read). */
  isEnabled(storeId: string): Promise<boolean> {
    return this.storeApps.isEnabled(storeId, 'b2b');
  }

  /** The app's settings with defaults merged (defaults when the app is off). */
  async getSettings(storeId: string): Promise<B2bSettings> {
    return parseB2bSettings(await this.storeApps.getSettings(storeId, 'b2b'));
  }

  /**
   * The buyer type a request runs as: COMPANY only when it was asked for,
   * the app is on and `allow_company` is not false; PERSON otherwise (what
   * every store did before the app).
   */
  async resolveBuyerType(
    storeId: string,
    requested?: string | null,
  ): Promise<BuyerType> {
    if (requested !== 'COMPANY') return 'PERSON';
    if (!(await this.isEnabled(storeId))) return 'PERSON';
    const settings = await this.getSettings(storeId);
    return settings.allow_company === false ? 'PERSON' : 'COMPANY';
  }

  /**
   * `options.allowed_customer_types` for a Kustom checkout: both kinds when
   * the store accepts company purchases, undefined (Kustom's default, person
   * only) otherwise - so payloads of stores without the app stay identical.
   */
  async kustomCustomerTypes(
    storeId: string,
  ): Promise<KustomCustomerType[] | undefined> {
    if (!(await this.isEnabled(storeId))) return undefined;
    const settings = await this.getSettings(storeId);
    return settings.allow_company === false
      ? undefined
      : ['person', 'organization'];
  }

  /**
   * Normalise a company input into the order snapshot and list what is
   * wrong with it, without throwing. Used by the lenient Kustom validation
   * callback, which must never fail on data Kustom already accepted.
   * Invalid values are kept as typed (trimmed) so nothing is lost.
   */
  normalizeCompany(
    input: Partial<CompanyInput> | null | undefined,
    country: string | null | undefined,
    settings: B2bSettings,
  ): { snapshot: CompanySnapshot; errors: B2bError[] } {
    const errors: B2bError[] = [];
    const name = (input?.company_name ?? '').trim().replace(/\s+/g, ' ');
    if (!name) {
      errors.push({
        code: 'B2B_COMPANY_NAME_REQUIRED',
        message: 'Company name is required.',
      });
    }

    const org = validateOrgNumber(country, input?.org_number, {
      strictCountries: settings.org_number_countries,
    });
    if (org.reason === 'EMPTY') {
      errors.push({
        code: 'B2B_ORG_NUMBER_REQUIRED',
        message: 'Organisation number is required.',
      });
    } else if (!org.ok) {
      errors.push({
        code: 'B2B_ORG_NUMBER_INVALID',
        message: `Invalid organisation number. Expected ${org.format}.`,
      });
    }

    const vatRaw = (input?.vat_number ?? '').trim();
    let vatNumber: string | null = null;
    if (vatRaw) {
      const vat = validateVatNumber(vatRaw);
      vatNumber = vat.normalized;
      if (!vat.ok) {
        errors.push({
          code: 'B2B_VAT_NUMBER_INVALID',
          message:
            'Invalid VAT number. Expected the country prefix followed by the registration number (e.g. SE556677889901).',
        });
      }
    } else if (settings.require_vat_number) {
      errors.push({
        code: 'B2B_VAT_NUMBER_REQUIRED',
        message: 'VAT number is required.',
      });
    }

    const reference = (input?.buyer_reference ?? '').trim();
    return {
      snapshot: {
        customer_type: 'COMPANY',
        company_name: name.slice(0, 200),
        org_number: org.normalized.slice(0, 32),
        vat_number: vatNumber ? vatNumber.slice(0, 32) : null,
        buyer_reference: reference ? reference.slice(0, 100) : null,
      },
      errors,
    };
  }

  /**
   * Strict version for order creation: the first problem becomes a 400 with
   * its B2B_* code (the storefront maps codes to inline messages).
   */
  validateCompany(
    input: Partial<CompanyInput> | null | undefined,
    country: string | null | undefined,
    settings: B2bSettings,
  ): CompanySnapshot {
    const { snapshot, errors } = this.normalizeCompany(
      input,
      country,
      settings,
    );
    if (errors.length) throw new BadRequestException(errors[0]);
    return snapshot;
  }
}
