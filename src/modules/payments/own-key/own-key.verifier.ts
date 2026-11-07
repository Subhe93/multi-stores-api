/**
 * Talks to the MERCHANT's Stripe account with the pasted restricted key:
 * permission checks, our webhook endpoint and payment method domains.
 * Stateless — the service persists what these return.
 */
import { HttpException } from '@nestjs/common';
import { toStripeAmount } from '../../../common/money/currency.util';
import {
  OWN_KEY_ERRORS,
  type StripeClient,
  type OwnKeyCheck,
  type OwnKeyPermission,
} from './own-key.types';
import {
  KEY_CHECK_PURPOSE,
  OWN_KEY_WEBHOOK_EVENTS,
  STRIPE_WEBHOOK_ENDPOINT_LIMIT,
  WEBHOOK_PLATFORM_TAG,
  accountFromMessage,
  isPermissionError,
  isRevokedKeyError,
  ownKeyError,
  permissionsFromMessage,
  safeMessage,
  stripeStatus,
  type KeyMode,
} from './own-key.util';

type WebhookEndpoint = Awaited<
  ReturnType<StripeClient['webhookEndpoints']['list']>
>['data'][number];
type PaymentMethodDomain = Awaited<
  ReturnType<StripeClient['paymentMethodDomains']['list']>
>['data'][number];

/** The API version every merchant webhook endpoint is pinned to. */
export const PINNED_API_VERSION = '2026-03-25.dahlia' as const;

export type Checks = Partial<Record<OwnKeyPermission, OwnKeyCheck>>;

export interface PermissionResult {
  checks: Checks;
  account_id: string | null;
  livemode: boolean | null;
  pi_write_check: 'test_create' | 'live_hint' | null;
  /** Stripe could not be reached / answered 5xx for some check. */
  unavailable: boolean;
}

/** Thrown for a 401 — the key is invalid, expired or revoked. */
export function invalidKeyError() {
  return ownKeyError(
    OWN_KEY_ERRORS.INVALID_OR_REVOKED,
    'Stripe rejected this key: it is invalid, expired or was revoked.',
  );
}

function noteError(
  err: unknown,
  perm: OwnKeyPermission,
  res: PermissionResult,
): void {
  if (isRevokedKeyError(err)) throw invalidKeyError();
  const msg = err instanceof Error ? err.message : String(err);
  res.account_id = res.account_id ?? accountFromMessage(msg);
  if (isPermissionError(err)) {
    res.checks[perm] = 'missing';
    for (const p of permissionsFromMessage(msg)) {
      if (p === perm) res.checks[p] = 'missing';
    }
    return;
  }
  const status = stripeStatus(err);
  if (status === null || status >= 500 || status === 429) {
    res.unavailable = true;
  }
  res.checks[perm] = res.checks[perm] === 'missing' ? 'missing' : 'unknown';
}

/**
 * Read checks + the Payment Intents write check (SPEC "PUT" steps 2 and 3).
 * Throws OWN_KEY_INVALID_OR_REVOKED on a 401; a 403 marks that permission
 * `missing` (the status decides, the `rak_*` name is informative only).
 */
export async function checkPermissions(
  client: StripeClient,
  mode: KeyMode,
  currency: string,
): Promise<PermissionResult> {
  const res: PermissionResult = {
    checks: {},
    account_id: null,
    livemode: null,
    pi_write_check: null,
    unavailable: false,
  };
  const reads: Array<[OwnKeyPermission, () => Promise<unknown>]> = [
    [
      'balance_read',
      async () => {
        const b = await client.balance.retrieve();
        res.livemode = b.livemode;
      },
    ],
    ['charge_read', () => client.charges.list({ limit: 1 })],
    ['payment_intent_write', () => client.paymentIntents.list({ limit: 1 })],
    ['webhook_write', () => client.webhookEndpoints.list({ limit: 1 })],
    [
      'payment_method_domain_write',
      () => client.paymentMethodDomains.list({ limit: 1 }),
    ],
    ['dispute_read', () => client.disputes.list({ limit: 1 })],
  ];
  // Sequential on purpose: the first 401 stops everything, and the
  // merchant's rate limit is not burned by a burst.
  for (const [perm, run] of reads) {
    try {
      await run();
      res.checks[perm] = 'ok';
    } catch (err) {
      noteError(err, perm, res);
    }
  }

  if (res.checks.payment_intent_write === 'ok') {
    await checkPaymentIntentWrite(client, mode, currency, res);
  }
  return res;
}

async function checkPaymentIntentWrite(
  client: StripeClient,
  mode: KeyMode,
  currency: string,
  res: PermissionResult,
): Promise<void> {
  const cur = (currency || 'EUR').toLowerCase();
  if (mode === 'test') {
    try {
      const pi = await client.paymentIntents.create({
        amount: toStripeAmount(10, cur),
        currency: cur,
        payment_method_types: ['card'],
        description: 'ShopsDoor key check (test mode, canceled)',
        metadata: { purpose: KEY_CHECK_PURPOSE },
      });
      res.pi_write_check = 'test_create';
      await client.paymentIntents.cancel(pi.id).catch(() => undefined);
    } catch (err) {
      if (stripeStatus(err) === 400) {
        // Validation ran, so the write permission is there.
        res.pi_write_check = 'test_create';
        return;
      }
      noteError(err, 'payment_intent_write', res);
    }
    return;
  }
  // Live mode: never create a real PaymentIntent. An invalid amount is
  // rejected with 400 when the permission exists and 403 when it does not.
  try {
    const pi = await client.paymentIntents.create({
      amount: -1,
      currency: cur,
      metadata: { purpose: KEY_CHECK_PURPOSE },
    });
    // Should never happen; clean up just in case.
    await client.paymentIntents.cancel(pi.id).catch(() => undefined);
    res.pi_write_check = 'live_hint';
  } catch (err) {
    if (stripeStatus(err) === 400) {
      res.pi_write_check = 'live_hint';
      return;
    }
    noteError(err, 'payment_intent_write', res);
  }
}

// ── Webhook endpoint ────────────────────────────────────────────────────

export interface EnsureWebhookInput {
  storeId: string;
  url: string;
  /** Endpoint id we stored before (only usable when we hold its secret). */
  knownEndpointId: string | null;
  haveSecret: boolean;
}

export interface EnsureWebhookResult {
  endpointId: string;
  /** Present only when a new endpoint was created (secret shown once). */
  secret: string | null;
}

function isOurs(e: WebhookEndpoint, storeId: string): boolean {
  return (
    e.metadata?.platform === WEBHOOK_PLATFORM_TAG &&
    e.metadata?.store_id === storeId
  );
}

function sameEvents(e: WebhookEndpoint): boolean {
  const have = new Set(e.enabled_events);
  return (
    have.size === OWN_KEY_WEBHOOK_EVENTS.length &&
    OWN_KEY_WEBHOOK_EVENTS.every((ev) => have.has(ev))
  );
}

/**
 * Idempotent: reuse our endpoint when we still hold its secret (updating
 * url/events), otherwise delete our stale endpoints and create a fresh one.
 * Errors: 401 -> INVALID_OR_REVOKED, 403 -> MISSING_PERMISSIONS
 * (webhook_write), 16 endpoints -> WEBHOOK_LIMIT, other -> WEBHOOK_FAILED.
 */
export async function ensureWebhookEndpoint(
  client: StripeClient,
  input: EnsureWebhookInput,
): Promise<EnsureWebhookResult> {
  try {
    const all: WebhookEndpoint[] = [];
    for await (const e of client.webhookEndpoints.list({ limit: 100 })) {
      all.push(e);
    }
    const ours = all.filter(
      (e) => isOurs(e, input.storeId) || e.url === input.url,
    );
    const reusable =
      input.haveSecret && input.knownEndpointId
        ? ours.find(
            (e) =>
              e.id === input.knownEndpointId &&
              isOurs(e, input.storeId) &&
              e.api_version === PINNED_API_VERSION,
          )
        : undefined;

    // Duplicates (and endpoints whose secret we lost) go away.
    for (const e of ours) {
      if (e.id !== reusable?.id) {
        await client.webhookEndpoints.del(e.id).catch((err: unknown) => {
          if (isRevokedKeyError(err) || isPermissionError(err)) throw err;
        });
      }
    }

    const metadata = { platform: WEBHOOK_PLATFORM_TAG, store_id: input.storeId };
    if (reusable) {
      if (
        reusable.url !== input.url ||
        !sameEvents(reusable) ||
        reusable.status !== 'enabled'
      ) {
        await client.webhookEndpoints.update(reusable.id, {
          url: input.url,
          enabled_events: [...OWN_KEY_WEBHOOK_EVENTS],
          disabled: false,
          metadata,
        });
      }
      return { endpointId: reusable.id, secret: null };
    }

    const remaining = all.length - ours.length;
    if (remaining >= STRIPE_WEBHOOK_ENDPOINT_LIMIT) {
      throw ownKeyError(
        OWN_KEY_ERRORS.WEBHOOK_LIMIT,
        `Your Stripe account already has ${STRIPE_WEBHOOK_ENDPOINT_LIMIT} webhook endpoints (the maximum). Delete one in the Stripe Dashboard and try again.`,
      );
    }
    const created = await client.webhookEndpoints.create({
      url: input.url,
      enabled_events: [...OWN_KEY_WEBHOOK_EVENTS],
      api_version: PINNED_API_VERSION,
      connect: false,
      description: 'ShopsDoor store payments',
      metadata,
    });
    if (!created.secret) {
      throw ownKeyError(
        OWN_KEY_ERRORS.WEBHOOK_FAILED,
        'Stripe did not return a signing secret for the webhook endpoint.',
      );
    }
    return { endpointId: created.id, secret: created.secret };
  } catch (err) {
    if (err instanceof HttpException) throw err;
    if (isRevokedKeyError(err)) throw invalidKeyError();
    if (isPermissionError(err)) {
      throw ownKeyError(
        OWN_KEY_ERRORS.MISSING_PERMISSIONS,
        'The key is missing a required permission: Webhook Endpoints (Write).',
        { missing: ['webhook_write'] },
      );
    }
    throw ownKeyError(
      OWN_KEY_ERRORS.WEBHOOK_FAILED,
      `Could not set up the webhook endpoint on your Stripe account: ${safeMessage(err)}`,
    );
  }
}

/** Best-effort removal of our endpoint (DELETE / key switch). */
export async function deleteWebhookEndpoint(
  client: StripeClient,
  endpointId: string | null,
  storeId: string,
): Promise<void> {
  try {
    if (endpointId) {
      await client.webhookEndpoints.del(endpointId).catch(() => undefined);
    }
    for await (const e of client.webhookEndpoints.list({ limit: 100 })) {
      if (isOurs(e, storeId)) {
        await client.webhookEndpoints.del(e.id).catch(() => undefined);
      }
    }
  } catch {
    // Best effort: a revoked key cannot clean up, which is fine.
  }
}

// ── Payment method domains ──────────────────────────────────────────────

const DOMAIN_METHODS = [
  'apple_pay',
  'google_pay',
  'link',
  'klarna',
  'paypal',
  'amazon_pay',
] as const;

export interface DomainsResult {
  domains: Record<string, Record<string, string>>;
  /** A 403 on create/validate: the domain write permission is missing. */
  permissionMissing: boolean;
}

function statusesOf(d: PaymentMethodDomain): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of DOMAIN_METHODS) {
    const s = (d as unknown as Record<string, { status?: string } | undefined>)[
      m
    ]?.status;
    if (s) out[m] = s;
  }
  return out;
}

/**
 * Registers (or reuses) and validates a payment method domain per host.
 * A failing host never fails the whole run: it gets `{ error: <code> }`.
 */
export async function registerDomains(
  client: StripeClient,
  hosts: string[],
): Promise<DomainsResult> {
  const result: DomainsResult = { domains: {}, permissionMissing: false };
  for (const host of hosts) {
    try {
      const existing = await client.paymentMethodDomains.list({
        domain_name: host,
        limit: 1,
      });
      let domain =
        existing.data[0] ??
        (await client.paymentMethodDomains.create({
          domain_name: host,
          enabled: true,
        }));
      if (!domain.enabled) {
        domain = await client.paymentMethodDomains.update(domain.id, {
          enabled: true,
        });
      }
      const statuses = statusesOf(domain);
      if (Object.values(statuses).some((s) => s !== 'active')) {
        domain = await client.paymentMethodDomains.validate(domain.id);
      }
      result.domains[host] = statusesOf(domain);
    } catch (err) {
      if (isRevokedKeyError(err)) throw invalidKeyError();
      if (isPermissionError(err)) {
        result.permissionMissing = true;
        result.domains[host] = { error: 'permission_missing' };
        continue;
      }
      const code =
        (err as { code?: unknown })?.code &&
        typeof (err as { code?: unknown }).code === 'string'
          ? String((err as { code: string }).code)
          : 'stripe_error';
      result.domains[host] = { error: code };
    }
  }
  return result;
}
