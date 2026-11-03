import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  isEuVatPrefix,
  parseViesResponse,
  splitViesNumber,
} from '../b2b/vies/vies.parse';
import { DEFAULT_VIES_BASE_URL } from '../b2b/vies/vies.types';

/** Hard cap on one VIES round trip of a trader-details save. */
export const TRADER_VAT_CHECK_TIMEOUT_MS = 6_000;

/**
 * Stored on `Store.trader_details.vat_check` (onboarding wave 3).
 * `valid` is null when VIES could not answer (timeout, 5xx,
 * MS_UNAVAILABLE, non-EU prefix): accepted, shown as "could not be
 * verified now", never blocks go-live. `false` blocks (hard fact).
 */
export interface TraderVatCheck {
  valid: boolean | null;
  checked_at: string;
  name?: string;
  address?: string;
}

/**
 * One-shot VIES lookup for the trader-details form. Deliberately simpler
 * than the b2b ViesService (no requester, no consultation log, no queue):
 * a merchant saves the form a handful of times, and the answer is stored
 * on the store. Uses global fetch so tests mock the transport.
 */
@Injectable()
export class TraderVatCheckService {
  private readonly logger = new Logger(TraderVatCheckService.name);
  private readonly url: string;

  constructor(@Optional() config?: ConfigService) {
    const base = (
      config?.get<string>('VIES_BASE_URL') || DEFAULT_VIES_BASE_URL
    ).replace(/\/$/, '');
    this.url = /check-vat-test-service$/.test(base)
      ? base
      : `${base}/check-vat-number`;
  }

  /**
   * Checks a normalised VAT number (`SE556016068001`). Never throws: every
   * failure to get an answer is `valid: null`.
   */
  async check(vatNumber: string, now = new Date()): Promise<TraderVatCheck> {
    const checked_at = now.toISOString();
    const prefix = vatNumber.slice(0, 2);
    if (!isEuVatPrefix(prefix)) {
      // Not a VIES member state: nothing to ask.
      return { valid: null, checked_at };
    }
    const { countryCode, number } = splitViesNumber(vatNumber);
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ countryCode, vatNumber: number }),
        signal: AbortSignal.timeout(TRADER_VAT_CHECK_TIMEOUT_MS),
      });
      if (res.status !== 200) {
        this.logger.warn(`VIES answered HTTP ${res.status} for ${countryCode}`);
        return { valid: null, checked_at };
      }
      let json: unknown = null;
      try {
        json = await res.json();
      } catch {
        json = null;
      }
      const parsed = parseViesResponse(json);
      if (parsed.status === 'VALID') {
        return {
          valid: true,
          checked_at,
          ...(parsed.name ? { name: parsed.name } : {}),
          ...(parsed.address ? { address: parsed.address } : {}),
        };
      }
      if (parsed.status === 'INVALID') return { valid: false, checked_at };
      this.logger.warn(
        `VIES unavailable for ${countryCode} (${parsed.error_code ?? 'unknown'})`,
      );
      return { valid: null, checked_at };
    } catch (err) {
      this.logger.warn(
        `VIES request failed for ${countryCode}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { valid: null, checked_at };
    }
  }
}
