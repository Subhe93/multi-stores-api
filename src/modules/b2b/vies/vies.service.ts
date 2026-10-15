import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../prisma/prisma.service';
import type { VatEvidence } from '../b2b.types';
import { validateVatNumber } from '../vat-number.util';
import { FetchViesHttpClient } from './vies.client';
import { MockViesHttpClient } from './vies.mock';
import {
  isEuVatPrefix,
  parseViesResponse,
  splitViesNumber,
} from './vies.parse';
import {
  DEFAULT_VIES_BASE_URL,
  DEFAULT_VIES_CACHE_TTL_HOURS,
  DEFAULT_VIES_TIMEOUT_MS,
  VIES_HTTP_CLIENT,
  type ViesCheckSource,
  type ViesHttpClient,
  type ViesMode,
  type ViesParsedResult,
  type ViesRequestBody,
} from './vies.types';

export interface ViesCheckOptions {
  /** The store asking (logged on VatNumberCheck; no FK). */
  storeId?: string | null;
  source: ViesCheckSource;
  /**
   * 'live' may call VIES; 'cached' only reads the caches and answers
   * `unavailable` / NOT_CHECKED on a miss (quote, storefront previews).
   */
  mode: 'live' | 'cached';
  /** Normalised EU VAT number sent as requester (consultation number). */
  requester?: string | null;
}

/** Negative cache of UNAVAILABLE answers. */
export const VIES_NEGATIVE_TTL_MS = 60_000;
/** A member state stays "unavailable" this long after MS_UNAVAILABLE / TIMEOUT. */
export const VIES_CIRCUIT_MS = 30_000;
/** At most this many VIES requests in flight per process. */
export const VIES_MAX_CONCURRENT = 4;
/**
 * Public storefront checks may hold at most this many of the slots, so
 * order / Kustom / dashboard checks always find one free.
 */
export const VIES_MAX_LOW_PRIORITY = 2;
/** Default wait for a free slot before failing closed (VIES_QUEUE_TIMEOUT_MS). */
export const DEFAULT_VIES_QUEUE_TIMEOUT_MS = 2000;
/** How long a store's resolved requester is reused. */
const REQUESTER_CACHE_MS = 60_000;
const L1_MAX_ENTRIES = 5000;
const CIRCUIT_ERRORS = new Set(['MS_UNAVAILABLE', 'TIMEOUT']);

/** Thrown internally when the service-side guard timer fires. */
class ViesTimeoutError extends Error {
  constructor() {
    super('VIES request timed out');
    this.name = 'TimeoutError';
  }
}

/**
 * VAT-number checks against VIES (b2b app, M2.5). Fail-closed: every
 * problem (format, non-EU prefix, VIES error, timeout, network) yields an
 * evidence whose status is not `valid`, and never throws. Results are
 * cached in memory (L1) and in VatNumberCheck (L2, also the audit log of
 * every consultation): VALID / INVALID for VIES_CACHE_TTL_HOURS,
 * UNAVAILABLE for 60 s. A member state that reported MS_UNAVAILABLE or
 * TIMEOUT is skipped for 30 s. Concurrent identical checks share one call
 * and at most four calls run at once.
 */
@Injectable()
export class ViesService {
  private readonly logger = new Logger(ViesService.name);
  readonly mode: ViesMode;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly http: ViesHttpClient;
  private readonly l1 = new Map<
    string,
    { evidence: VatEvidence; expires: number }
  >();
  private readonly circuit = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<VatEvidence>>();
  private active = 0;
  private activeLow = 0;
  private readonly waiters: {
    low: boolean;
    grant: () => void;
  }[] = [];
  private readonly queueTimeoutMs: number;
  private readonly requesters = new Map<
    string,
    { value: string | null; expires: number }
  >();

  constructor(
    private readonly prisma: PrismaService,
    @Optional() config?: ConfigService,
    @Optional() @Inject(VIES_HTTP_CLIENT) http?: ViesHttpClient,
  ) {
    const rawMode = String(config?.get<string>('VIES_MODE') ?? 'live')
      .trim()
      .toLowerCase();
    this.mode =
      rawMode === 'mock' || rawMode === 'off' ? (rawMode as ViesMode) : 'live';
    const base = String(
      config?.get<string>('VIES_BASE_URL') || DEFAULT_VIES_BASE_URL,
    ).replace(/\/+$/, '');
    // A base that already names the operation (the test service) is used
    // as is; otherwise the production operation is appended.
    this.url = /\/check-vat[^/]*$/.test(base)
      ? base
      : `${base}/check-vat-number`;
    this.timeoutMs = positive(
      config?.get<string>('VIES_TIMEOUT_MS'),
      DEFAULT_VIES_TIMEOUT_MS,
    );
    this.ttlMs =
      positive(
        config?.get<string>('VIES_CACHE_TTL_HOURS'),
        DEFAULT_VIES_CACHE_TTL_HOURS,
      ) * 3_600_000;
    this.queueTimeoutMs = positive(
      config?.get<string>('VIES_QUEUE_TIMEOUT_MS'),
      DEFAULT_VIES_QUEUE_TIMEOUT_MS,
    );
    this.http =
      http ??
      (this.mode === 'mock'
        ? new MockViesHttpClient()
        : new FetchViesHttpClient());
  }

  /**
   * The requester VAT number for a store: the b2b setting when given, else
   * the seller VAT number of the invoices legal profile (when it is a
   * format-valid EU number). Null = check without requester.
   */
  async requesterFor(
    storeId: string,
    override: string | null | undefined,
  ): Promise<string | null> {
    const fromSetting = euVat(override);
    if (fromSetting) return fromSetting;
    const cached = this.requesters.get(storeId);
    if (cached && cached.expires > Date.now()) return cached.value;
    let value: string | null = null;
    try {
      const profile = await this.prisma.storeLegalProfile.findUnique({
        where: { store_id_key: { store_id: storeId, key: 'default' } },
        select: { vat_number: true },
      });
      value = euVat(profile?.vat_number);
    } catch {
      value = null;
    }
    this.requesters.set(storeId, {
      value,
      expires: Date.now() + REQUESTER_CACHE_MS,
    });
    return value;
  }

  /** Check one VAT number. Never throws. */
  async check(
    raw: string | null | undefined,
    opts: ViesCheckOptions,
  ): Promise<VatEvidence> {
    const format = validateVatNumber(raw);
    if (!format.ok || !format.country) {
      return this.local(
        format.normalized,
        format.country ?? '',
        'format_invalid',
      );
    }
    if (!isEuVatPrefix(format.country)) {
      return this.local(format.normalized, format.country, 'not_eu');
    }
    const { countryCode, number } = splitViesNumber(format.normalized);
    const vat = countryCode + number;
    if (this.mode === 'off') {
      return this.local(vat, countryCode, 'unavailable', 'VIES_OFF');
    }
    const requester = euVat(opts.requester);
    // Evidence is per store and requester: a consultation number (and the
    // audit row behind it) of one store is never handed to another.
    const storeId = opts.storeId ?? null;
    const key = `${storeId ?? ''}|${vat}|${requester ?? ''}`;

    const l1 = this.l1.get(key);
    if (l1 && l1.expires > Date.now()) return { ...l1.evidence };
    if (l1) this.l1.delete(key);

    const l2 = await this.fromLog(vat, storeId, requester);
    if (l2) {
      this.remember(key, l2.evidence, l2.expires);
      return { ...l2.evidence };
    }

    if (opts.mode === 'cached') {
      return this.local(vat, countryCode, 'unavailable', 'NOT_CHECKED');
    }

    const until = this.circuit.get(countryCode);
    if (until && until > Date.now()) {
      return this.local(vat, countryCode, 'unavailable', 'MS_UNAVAILABLE');
    }

    const pending = this.inFlight.get(key);
    if (pending) return { ...(await pending) };
    const run = this.live(vat, countryCode, number, requester, opts).finally(
      () => this.inFlight.delete(key),
    );
    this.inFlight.set(key, run);
    const evidence = await run;
    const ttl =
      evidence.status === 'unavailable' ? VIES_NEGATIVE_TTL_MS : this.ttlMs;
    this.remember(key, evidence, Date.now() + ttl);
    return { ...evidence };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async live(
    vat: string,
    countryCode: string,
    number: string,
    requester: string | null,
    opts: ViesCheckOptions,
  ): Promise<VatEvidence> {
    // The public storefront check is low priority (bounded share of the
    // slots); every wait is bounded and fails closed.
    const low = opts.source === 'storefront';
    if (!(await this.acquire(low))) {
      return this.local(vat, countryCode, 'unavailable', 'QUEUE_TIMEOUT');
    }
    let result: ViesParsedResult;
    let usedRequester = requester;
    try {
      result = await this.call(countryCode, number, requester);
      if (result.error_code === 'INVALID_REQUESTER_INFO' && requester) {
        this.logger.warn(
          `VIES rejected requester ${maskVat(requester)}; retrying ${maskVat(vat)} without it`,
        );
        usedRequester = null;
        result = await this.call(countryCode, number, null);
      }
    } finally {
      this.release(low);
    }
    if (
      result.status === 'UNAVAILABLE' &&
      result.error_code &&
      CIRCUIT_ERRORS.has(result.error_code)
    ) {
      this.circuit.set(countryCode, Date.now() + VIES_CIRCUIT_MS);
    }
    const checkedAt = new Date();
    const checkId = await this.log(vat, countryCode, result, {
      requester: usedRequester,
      checkedAt,
      storeId: opts.storeId ?? null,
      source: opts.source,
    });
    return {
      source: 'VIES',
      vat_number: vat,
      country_code: countryCode,
      status:
        result.status === 'VALID'
          ? 'valid'
          : result.status === 'INVALID'
            ? 'invalid'
            : 'unavailable',
      valid: result.status === 'VALID',
      name: result.name,
      address: result.address,
      request_identifier: result.request_identifier,
      requester: usedRequester,
      checked_at: checkedAt.toISOString(),
      check_id: checkId,
      error_code: result.error_code,
    };
  }

  /** One HTTP round trip, mapped to a parsed result (never throws). */
  private async call(
    countryCode: string,
    number: string,
    requester: string | null,
  ): Promise<ViesParsedResult> {
    const body: ViesRequestBody = { countryCode, vatNumber: number };
    if (requester) {
      const r = splitViesNumber(requester);
      body.requesterMemberStateCode = r.countryCode;
      body.requesterNumber = r.number;
    }
    let timer: NodeJS.Timeout | undefined;
    try {
      const guard = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new ViesTimeoutError()),
          this.timeoutMs,
        );
      });
      const res = await Promise.race([
        this.http.post(this.url, body, this.timeoutMs),
        guard,
      ]);
      if (res.status !== 200) return failed(`HTTP_${res.status}`);
      return parseViesResponse(res.json);
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      const code =
        name === 'TimeoutError' || name === 'AbortError'
          ? 'TIMEOUT'
          : 'NETWORK_ERROR';
      this.logger.warn(
        `VIES ${maskVat(countryCode + number)} failed (${code}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return failed(code);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Latest VALID / INVALID consultation within the TTL (L2). */
  private async fromLog(
    vat: string,
    storeId: string | null,
    requester: string | null,
  ): Promise<{ evidence: VatEvidence; expires: number } | null> {
    try {
      const row = await this.prisma.vatNumberCheck.findFirst({
        where: {
          vat_number: vat,
          store_id: storeId,
          requester,
          // Rows answered by the mock never serve live mode (and back).
          mode: this.mode,
          status: { in: ['VALID', 'INVALID'] },
          checked_at: { gt: new Date(Date.now() - this.ttlMs) },
        },
        orderBy: { checked_at: 'desc' },
      });
      if (!row) return null;
      const valid = row.status === 'VALID';
      return {
        expires: row.checked_at.getTime() + this.ttlMs,
        evidence: {
          source: 'VIES',
          vat_number: row.vat_number,
          country_code: row.country_code,
          status: valid ? 'valid' : 'invalid',
          valid,
          name: row.name,
          address: row.address,
          request_identifier: row.request_identifier,
          requester: row.requester,
          checked_at: row.checked_at.toISOString(),
          check_id: row.id,
          error_code: row.error_code,
        },
      };
    } catch (err) {
      this.logger.debug(
        `VatNumberCheck lookup skipped: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  /** Best-effort audit row; the id or null. Never throws. */
  private async log(
    vat: string,
    countryCode: string,
    result: ViesParsedResult,
    meta: {
      requester: string | null;
      checkedAt: Date;
      storeId: string | null;
      source: ViesCheckSource;
    },
  ): Promise<string | null> {
    try {
      const requestDate = result.request_date
        ? new Date(result.request_date)
        : null;
      const row = await this.prisma.vatNumberCheck.create({
        data: {
          vat_number: vat.slice(0, 32),
          country_code: countryCode.slice(0, 2),
          status: result.status,
          error_code: result.error_code?.slice(0, 40) ?? null,
          name: result.name,
          address: result.address,
          request_identifier: result.request_identifier?.slice(0, 64) ?? null,
          requester: meta.requester?.slice(0, 32) ?? null,
          request_date:
            requestDate && !Number.isNaN(requestDate.getTime())
              ? requestDate
              : null,
          checked_at: meta.checkedAt,
          store_id: meta.storeId,
          source: meta.source,
          mode: this.mode,
        },
        select: { id: true },
      });
      return row.id;
    } catch (err) {
      this.logger.warn(
        `VatNumberCheck write failed for ${maskVat(vat)}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }
  }

  private remember(key: string, evidence: VatEvidence, expires: number) {
    if (this.l1.size >= L1_MAX_ENTRIES) {
      const oldest = this.l1.keys().next();
      if (!oldest.done) this.l1.delete(oldest.value);
    }
    this.l1.set(key, { evidence: { ...evidence }, expires });
  }

  /** Evidence decided without VIES (format, territory, mode, cache miss). */
  private local(
    vat: string,
    countryCode: string,
    status: VatEvidence['status'],
    errorCode: string | null = null,
  ): VatEvidence {
    return {
      source: 'VIES',
      vat_number: vat,
      country_code: countryCode,
      status,
      valid: false,
      name: null,
      address: null,
      request_identifier: null,
      requester: null,
      checked_at: new Date().toISOString(),
      check_id: null,
      error_code: errorCode,
    };
  }

  private canRun(low: boolean): boolean {
    return (
      this.active < VIES_MAX_CONCURRENT &&
      (!low || this.activeLow < VIES_MAX_LOW_PRIORITY)
    );
  }

  private take(low: boolean): void {
    this.active++;
    if (low) this.activeLow++;
  }

  /**
   * A slot for one live call; false when none freed up within
   * VIES_QUEUE_TIMEOUT_MS (the caller then fails closed).
   */
  private acquire(low: boolean): Promise<boolean> {
    if (this.canRun(low) && (low || !this.waiters.some((w) => !w.low))) {
      this.take(low);
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const waiter = {
        low,
        grant: () => {
          clearTimeout(timer);
          this.take(low);
          resolve(true);
        },
      };
      const timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(false);
      }, this.queueTimeoutMs);
      this.waiters.push(waiter);
    });
  }

  /** Free a slot and grant it: high-priority waiters first. */
  private release(low: boolean): void {
    this.active--;
    if (low) this.activeLow--;
    while (this.waiters.length) {
      const i =
        this.waiters.findIndex((w) => !w.low) >= 0
          ? this.waiters.findIndex((w) => !w.low)
          : this.waiters.findIndex((w) => this.canRun(w.low));
      if (i < 0 || !this.canRun(this.waiters[i].low)) return;
      const [next] = this.waiters.splice(i, 1);
      next.grant();
    }
  }
}

function failed(code: string): ViesParsedResult {
  return {
    status: 'UNAVAILABLE',
    valid: false,
    name: null,
    address: null,
    request_identifier: null,
    request_date: null,
    error_code: code,
  };
}

/** A VAT number for logs: country prefix and last four characters only. */
export function maskVat(vat: string | null | undefined): string {
  const v = (vat ?? '').toUpperCase();
  if (v.length <= 6) return v ? `${v.slice(0, 2)}***` : '';
  return `${v.slice(0, 2)}***${v.slice(-4)}`;
}

function positive(raw: unknown, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Normalised VAT number when it is a format-valid EU / XI number. */
function euVat(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  const v = validateVatNumber(raw);
  if (!v.ok || !v.country || !isEuVatPrefix(v.country)) return null;
  const { countryCode, number } = splitViesNumber(v.normalized);
  return countryCode + number;
}
