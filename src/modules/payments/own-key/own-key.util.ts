/**
 * Pure helpers of the own-key module (no Nest / Prisma): key validation,
 * secret redaction, Stripe error classification and permission mapping.
 */
import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import {
  OWN_KEY_ERRORS,
  type OwnKeyCheck,
  type OwnKeyPermission,
} from './own-key.types';

export type KeyMode = 'live' | 'test';

/** Permissions the store cannot take payments without. */
export const REQUIRED_PERMISSIONS: readonly OwnKeyPermission[] = [
  'payment_intent_write',
  'charge_read',
  'webhook_write',
  'payment_method_domain_write',
  'balance_read',
];
export const OPTIONAL_PERMISSIONS: readonly OwnKeyPermission[] = [
  'dispute_read',
];
export const ALL_PERMISSIONS: readonly OwnKeyPermission[] = [
  ...REQUIRED_PERMISSIONS,
  ...OPTIONAL_PERMISSIONS,
];

/** Events our per-store webhook endpoint subscribes to on the merchant account. */
export const OWN_KEY_WEBHOOK_EVENTS = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'payment_intent.processing',
  'payment_intent.requires_action',
  'charge.refunded',
  'charge.refund.updated',
  'refund.created',
  'refund.updated',
  'refund.failed',
  'charge.dispute.created',
  'charge.dispute.updated',
  'charge.dispute.closed',
] as const;

/** Stripe allows at most this many webhook endpoints per account. */
export const STRIPE_WEBHOOK_ENDPOINT_LIMIT = 16;

/** Metadata `purpose` of the test-mode PaymentIntent created by the check. */
export const KEY_CHECK_PURPOSE = 'shopsdoor_key_check';
export const WEBHOOK_PLATFORM_TAG = 'shopsdoor';

const RESTRICTED_RE = /^rk_(live|test)_[A-Za-z0-9]{8,}$/;
const PUBLISHABLE_RE = /^pk_(live|test)_[A-Za-z0-9]{8,}$/;
const SECRET_RE = /^sk_(live|test)_/;

export function ownKeyError(
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): BadRequestException {
  return new BadRequestException({ code, message, ...extra });
}

/**
 * Validates the pasted pair: restricted + publishable key of the same mode.
 * `sk_` keys are refused outright (full-access keys must never be stored).
 */
export function validateKeyPair(
  publishableRaw: string,
  restrictedRaw: string,
): { publishable: string; restricted: string; mode: KeyMode } {
  const publishable = (publishableRaw ?? '').trim();
  const restricted = (restrictedRaw ?? '').trim();
  if (SECRET_RE.test(restricted) || SECRET_RE.test(publishable)) {
    throw ownKeyError(
      OWN_KEY_ERRORS.SECRET_KEY_REJECTED,
      'Secret keys (sk_) are not accepted. Create a restricted key (rk_) with the listed permissions.',
      { fields: ['restricted_key'] },
    );
  }
  const rk = RESTRICTED_RE.exec(restricted);
  const pk = PUBLISHABLE_RE.exec(publishable);
  if (!rk || !pk) {
    const fields: string[] = [];
    if (!rk) fields.push('restricted_key');
    if (!pk) fields.push('publishable_key');
    throw ownKeyError(
      OWN_KEY_ERRORS.INVALID_PREFIX,
      'The restricted key must start with rk_live_ or rk_test_ and the publishable key with pk_live_ or pk_test_.',
      { fields },
    );
  }
  if (rk[1] !== pk[1]) {
    throw ownKeyError(
      OWN_KEY_ERRORS.MODE_MISMATCH,
      'Both keys must be from the same mode (both live or both test).',
      { fields: ['publishable_key', 'restricted_key'] },
    );
  }
  return { publishable, restricted, mode: rk[1] as KeyMode };
}

/** Removes anything that looks like a Stripe secret from a message. */
export function redactSecrets(text: string): string {
  return String(text ?? '').replace(
    /\b(rk|sk|whsec)_(live_|test_)?[A-Za-z0-9*]+/g,
    (_m, kind: string, mode: string | undefined) => `${kind}_${mode ?? ''}***`,
  );
}

/** HTTP status of a Stripe SDK error (or anything shaped like one). */
export function stripeStatus(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as { statusCode?: unknown; raw?: { statusCode?: unknown } };
  const s = e.statusCode ?? e.raw?.statusCode;
  return typeof s === 'number' ? s : null;
}

/** 401 = invalid / expired / revoked key. Payment code calls markRevoked then. */
export function isRevokedKeyError(err: unknown): boolean {
  return stripeStatus(err) === 401;
}

export function isPermissionError(err: unknown): boolean {
  return stripeStatus(err) === 403;
}

/** Safe, redacted message of an error (for logs / last_error_code detail). */
export function safeMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return redactSecrets(msg).slice(0, 300);
}

/** `rak_*` permission names a 403 message mentions, mapped to our ids. */
export function permissionsFromMessage(message: string): OwnKeyPermission[] {
  const out = new Set<OwnKeyPermission>();
  for (const m of String(message ?? '').matchAll(/rak_[a-z_]+/g)) {
    const p = mapRakPermission(m[0]);
    if (p) out.add(p);
  }
  return [...out];
}

export function mapRakPermission(rak: string): OwnKeyPermission | null {
  const name = rak.toLowerCase();
  if (name.startsWith('rak_payment_intent')) return 'payment_intent_write';
  if (name.startsWith('rak_payment_method_domain'))
    return 'payment_method_domain_write';
  if (name.startsWith('rak_webhook') || name.startsWith('rak_event_destination'))
    return 'webhook_write';
  if (name.startsWith('rak_charge') || name.startsWith('rak_refund'))
    return 'charge_read';
  if (name.startsWith('rak_balance')) return 'balance_read';
  if (name.startsWith('rak_dispute')) return 'dispute_read';
  return null;
}

/** Merchant account id (`acct_...`) a Stripe message names, if any. */
export function accountFromMessage(message: string): string | null {
  const m = /\bacct_[A-Za-z0-9]{6,}\b/.exec(String(message ?? ''));
  return m ? m[0] : null;
}

export function missingRequired(
  checks: Partial<Record<OwnKeyPermission, OwnKeyCheck>>,
): OwnKeyPermission[] {
  return REQUIRED_PERMISSIONS.filter((p) => checks[p] === 'missing');
}

/** `<PUBLIC_API_URL>/api/payments/webhook/store/<storeId>`. */
export function webhookUrlFor(publicApiUrl: string, storeId: string): string {
  const base = publicApiUrl.trim().replace(/\/+$/, '').replace(/\/api$/, '');
  return `${base}/api/payments/webhook/store/${encodeURIComponent(storeId)}`;
}

/**
 * Short, non-reversible fingerprint of a restricted key (16 hex chars of
 * SHA-256). Restricted keys are high-entropy, so the hash cannot be brute
 * forced; it identifies which key an order was paid with, never the key.
 */
export function keyFingerprint(restrictedKey: string): string {
  return createHash('sha256')
    .update(String(restrictedKey ?? ''))
    .digest('hex')
    .slice(0, 16);
}
