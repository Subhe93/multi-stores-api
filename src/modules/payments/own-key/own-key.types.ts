/**
 * Contract between the own-key module (merchant restricted keys) and the
 * payment flow. See plans/stripe-restricted-keys/SPEC.md. Owned by the
 * own-key module; the payment flow codes against these types only.
 */
import type Stripe from 'stripe';

/** Instance type of a stripe-node client (the default export is a namespace). */
export type StripeClient = InstanceType<typeof Stripe>;

export type OwnKeyState = 'ACTIVE' | 'NEEDS_RECONNECT' | 'DISABLED';
export type OwnKeyPermission =
  | 'payment_intent_write'
  | 'charge_read'
  | 'webhook_write'
  | 'payment_method_domain_write'
  | 'balance_read'
  | 'dispute_read';
export type OwnKeyCheck = 'ok' | 'missing' | 'unknown';

export interface OwnKeyStatus {
  status: OwnKeyState;
  livemode: boolean;
  key_last4: string;
  account_id: string | null;
  permissions: Partial<Record<OwnKeyPermission, OwnKeyCheck>>;
  webhook_ok: boolean;
  payment_method_domains: Record<string, Record<string, string>>;
  verified_at: string | null;
  last_check_at: string | null;
  last_error_code: string | null;
  /**
   * How the Payment Intents write permission was proven: `test_create` (a
   * real PI was created + canceled in test mode) or `live_hint` (live mode:
   * an invalid POST was accepted for validation, so the permission is
   * granted; the first real checkout confirms it). Null before a check.
   */
  pi_write_check: 'test_create' | 'live_hint' | null;
}

/** A merchant client plus which stored key it was built from. */
export interface OwnKeyClientEntry {
  client: StripeClient;
  /** keyFingerprint() of the key behind the client (never the key). */
  fingerprint: string;
  /** True when this is the read-only key the current one replaced. */
  previous: boolean;
  livemode: boolean;
}

/** Implemented by OwnKeyService (Nest provider exported by OwnKeyModule). */
export interface OwnKeyApi {
  getStatus(storeId: string): Promise<OwnKeyStatus | null>;
  /**
   * ACTIVE key of an INDEPENDENT store. A TEST-mode key only counts with
   * `allowTest` (owner / admin preview), never for the public checkout.
   */
  isActive(storeId: string, opts?: { allowTest?: boolean }): Promise<boolean>;
  /** Status + mode of the stored key (null without a row). */
  getMode(
    storeId: string,
  ): Promise<{ status: OwnKeyState; livemode: boolean } | null>;
  getPublishableKey(storeId: string): Promise<string | null>;
  /** Cached merchant client; throws OWN_KEY_NOT_ACTIVE when not ACTIVE. */
  getClient(storeId: string): Promise<StripeClient>;
  /**
   * Client for an order: the previous (replaced) key when `fingerprint`
   * names it and it has not expired, else the current ACTIVE key. Throws
   * OWN_KEY_NOT_ACTIVE when neither applies.
   */
  getClientEntry(
    storeId: string,
    opts?: { fingerprint?: string | null },
  ): Promise<OwnKeyClientEntry>;
  getWebhookSecret(storeId: string): Promise<string | null>;
  /**
   * Every signing secret the store endpoint accepts: the current endpoint
   * and, until it expires, the endpoint left on the replaced key's account.
   */
  getWebhookSecrets(storeId: string): Promise<string[]>;
  /**
   * 401 from the merchant key: NEEDS_RECONNECT + owner notice. Idempotent.
   * With `fingerprint` (the key the failing client was built from) the flip
   * only happens while that key is still the current one, so a late 401 of
   * an old client never disables a freshly connected key.
   */
  markRevoked(
    storeId: string,
    reason: string,
    fingerprint?: string | null,
  ): Promise<void>;
  invalidate(storeId: string): void;
}

/** Injection token so the payment flow can depend on the contract only. */
export const OWN_KEY_API = Symbol('OWN_KEY_API');

export const OWN_KEY_ERRORS = {
  NOT_ACTIVE: 'OWN_KEY_NOT_ACTIVE',
  INVALID_PREFIX: 'OWN_KEY_INVALID_PREFIX',
  SECRET_KEY_REJECTED: 'OWN_KEY_SECRET_KEY_REJECTED',
  MODE_MISMATCH: 'OWN_KEY_MODE_MISMATCH',
  INVALID_OR_REVOKED: 'OWN_KEY_INVALID_OR_REVOKED',
  MISSING_PERMISSIONS: 'OWN_KEY_MISSING_PERMISSIONS',
  WEBHOOK_FAILED: 'OWN_KEY_WEBHOOK_FAILED',
  INDEPENDENT_ONLY: 'OWN_KEY_INDEPENDENT_ONLY',
  USE_OWN_STRIPE_KEY: 'USE_OWN_STRIPE_KEY',
  NOT_FOUND: 'OWN_KEY_NOT_FOUND',
  WEBHOOK_LIMIT: 'OWN_KEY_WEBHOOK_LIMIT',
  STRIPE_UNAVAILABLE: 'OWN_KEY_STRIPE_UNAVAILABLE',
  /** Another save / verify / remove of the same store holds the lease. */
  BUSY: 'OWN_KEY_BUSY',
} as const;
