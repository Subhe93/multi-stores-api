import {
  BadRequestException,
  Injectable,
  Logger,
  type OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Cloudflare Turnstile server-side verification endpoint. */
export const TURNSTILE_VERIFY_URL =
  'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** Hard cap on one siteverify round trip. */
export const TURNSTILE_TIMEOUT_MS = 5_000;

/** Shape of the siteverify answer (the part we read). */
interface SiteVerifyResponse {
  success?: boolean;
  'error-codes'?: string[];
  /** Hostname of the page the widget was solved on. */
  hostname?: string;
}

/** Extra checks on an accepted token. */
export interface TurnstileVerifyOptions {
  /**
   * The token must have been solved on one of these hosts (or a subdomain of
   * one listed with a leading dot, e.g. `.shopsdoor.com`). A token solved on
   * another site that reuses the public site key is refused. Omitted = any.
   */
  hostnames?: readonly string[];
}

/** Whether `host` matches the allow-list (exact, or `.suffix` entries). */
export function turnstileHostAllowed(
  host: string | undefined,
  allowed: readonly string[],
): boolean {
  const h = (host ?? '').trim().toLowerCase();
  if (!h) return false;
  return allowed.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    return e.startsWith('.') ? h.endsWith(e) || h === e.slice(1) : h === e;
  });
}

/**
 * Cloudflare Turnstile on the platform sign-up (onboarding wave 3).
 *
 * Feature flag = `TURNSTILE_SECRET_KEY`: unset → `enabled` is false and
 * `verify` is a no-op ("turnstile: off" logged once at boot). Set → the
 * token sent by the web register wizard is checked against siteverify
 * (POST form: secret, response, remoteip; 5 s timeout). Fail-closed: a
 * missing or rejected token is 400 AUTH_CAPTCHA_FAILED; a network error,
 * timeout or non-2xx answer is 503 AUTH_CAPTCHA_UNAVAILABLE so the user
 * can retry instead of being told the captcha was wrong.
 *
 * Storefront customers (register, guest checkout) are checked too when
 * `TURNSTILE_CUSTOMERS=on` as well: their pages run on custom domains, which
 * must first be added to the Turnstile widget's hostname list in Cloudflare.
 */
@Injectable()
export class TurnstileService implements OnModuleInit {
  private readonly logger = new Logger(TurnstileService.name);
  private readonly secret: string;

  private readonly customers: boolean;

  constructor(@Optional() config?: ConfigService) {
    this.secret = (config?.get<string>('TURNSTILE_SECRET_KEY') ?? '').trim();
    const flag = (config?.get<string>('TURNSTILE_CUSTOMERS') ?? '').trim();
    this.customers = /^(on|1|true)$/i.test(flag);
  }

  onModuleInit(): void {
    this.logger.log(
      this.enabled
        ? `turnstile: on (customers: ${this.customersEnabled ? 'on' : 'off'})`
        : 'turnstile: off',
    );
  }

  /** Storefront sign-up and guest checkout also need a token. */
  get customersEnabled(): boolean {
    return this.enabled && this.customers;
  }

  /** True when a secret is configured (sign-up requires a token). */
  get enabled(): boolean {
    return this.secret.length > 0;
  }

  /**
   * Verifies a widget token. Resolves when the feature is off or the token
   * is accepted; throws the two coded HTTP errors otherwise.
   */
  async verify(
    token: string | null | undefined,
    remoteIp?: string | null,
    opts: TurnstileVerifyOptions = {},
  ): Promise<void> {
    if (!this.enabled) return;
    const response = (token ?? '').trim();
    if (!response || response.length > 2048) {
      throw this.failed('missing-input-response');
    }

    const form = new URLSearchParams();
    form.set('secret', this.secret);
    form.set('response', response);
    if (remoteIp) form.set('remoteip', remoteIp);

    let json: SiteVerifyResponse | null = null;
    try {
      const res = await fetch(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        signal: AbortSignal.timeout(TURNSTILE_TIMEOUT_MS),
      });
      if (!res.ok) throw this.unavailable(`HTTP ${res.status}`);
      json = (await res.json()) as SiteVerifyResponse;
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw this.unavailable(err instanceof Error ? err.message : String(err));
    }
    if (json?.success !== true) {
      throw this.failed((json?.['error-codes'] ?? []).join(',') || 'rejected');
    }
    if (
      opts.hostnames &&
      !turnstileHostAllowed(json.hostname, opts.hostnames)
    ) {
      throw this.failed('hostname-mismatch');
    }
  }

  /** verify() for a storefront customer form; a no-op unless switched on. */
  async verifyCustomer(
    token: string | null | undefined,
    remoteIp: string | null | undefined,
    hostnames: readonly string[],
  ): Promise<void> {
    if (!this.customersEnabled) return;
    await this.verify(token, remoteIp, { hostnames });
  }

  private failed(reason: string): BadRequestException {
    this.logger.warn(`turnstile: token rejected (${reason})`);
    return new BadRequestException({
      code: 'AUTH_CAPTCHA_FAILED',
      message: 'The security check failed. Please try again.',
    });
  }

  private unavailable(reason: string): ServiceUnavailableException {
    this.logger.warn(`turnstile: siteverify unavailable (${reason})`);
    return new ServiceUnavailableException({
      code: 'AUTH_CAPTCHA_UNAVAILABLE',
      message:
        'The security check is temporarily unavailable. Please try again.',
    });
  }
}
