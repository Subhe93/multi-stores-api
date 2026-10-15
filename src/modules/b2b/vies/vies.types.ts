// VIES (EU VAT Information Exchange System) integration of the b2b app
// (M2.5). Only the REST POST endpoint is used: it supports the requester
// (consultation number) and has a single response shape.

/** What the transport returns: the HTTP status and the parsed JSON body. */
export interface ViesHttpResponse {
  status: number;
  /** Parsed body; null when it was not JSON. */
  json: unknown;
}

/** Transport seam, injectable so tests never touch the network. */
export interface ViesHttpClient {
  post(
    url: string,
    body: unknown,
    timeoutMs: number,
  ): Promise<ViesHttpResponse>;
}

/** DI token of the ViesHttpClient (fetch in live mode, the mock otherwise). */
export const VIES_HTTP_CLIENT = Symbol('VIES_HTTP_CLIENT');

/** VIES_MODE: live = EC REST service, mock = local rules, off = never valid. */
export type ViesMode = 'live' | 'mock' | 'off';

/** Who asked for a check (VatNumberCheck.source). */
export type ViesCheckSource =
  | 'storefront'
  | 'quote'
  | 'order'
  | 'kustom'
  | 'dashboard';

/** Outcome of one VIES answer, before it becomes a VatEvidence. */
export interface ViesParsedResult {
  status: 'VALID' | 'INVALID' | 'UNAVAILABLE';
  valid: boolean;
  name: string | null;
  address: string | null;
  request_identifier: string | null;
  /** VIES requestDate (ISO string) when present. */
  request_date: string | null;
  /** VIES error code (INVALID_INPUT, MS_UNAVAILABLE, ...) or a local one. */
  error_code: string | null;
}

/** Request body of POST /check-vat-number (and the test service). */
export interface ViesRequestBody {
  countryCode: string;
  vatNumber: string;
  requesterMemberStateCode?: string;
  requesterNumber?: string;
}

export const DEFAULT_VIES_BASE_URL =
  'https://ec.europa.eu/taxation_customs/vies/rest-api';
export const DEFAULT_VIES_TIMEOUT_MS = 4000;
export const DEFAULT_VIES_CACHE_TTL_HOURS = 24;
