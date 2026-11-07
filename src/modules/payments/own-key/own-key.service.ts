import {
  ConflictException,
  HttpException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, StoreType, type StoreStripeKeys } from '@prisma/client';
import Stripe from 'stripe';
import { PrismaService } from '../../../prisma/prisma.service';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { RevalidationService } from '../../../common/revalidation/revalidation.service';
import { resolveStoreCurrency } from '../../../common/money/currency.util';
import { platformHosts } from '../../../common/domains/platform-hosts';
import { NotificationsService } from '../../notifications/notifications.service';
import { SecurityAuditService } from '../../security/security-audit.service';
import { StoreAppsService } from '../../store-apps/store-apps.service';
import { loadStorefrontHosts } from '../../stores/storefront-hosts';
import {
  OWN_KEY_ERRORS,
  type OwnKeyApi,
  type OwnKeyClientEntry,
  type OwnKeyCheck,
  type OwnKeyPermission,
  type OwnKeyState,
  type OwnKeyStatus,
  type StripeClient,
} from './own-key.types';
import {
  ALL_PERMISSIONS,
  isRevokedKeyError,
  keyFingerprint,
  missingRequired,
  ownKeyError,
  redactSecrets,
  safeMessage,
  validateKeyPair,
  webhookUrlFor,
  type KeyMode,
} from './own-key.util';
import {
  checkPermissions,
  deleteWebhookEndpoint,
  ensureWebhookEndpoint,
  invalidKeyError,
  registerDomains,
  type Checks,
} from './own-key.verifier';

/** Builds a Stripe client for a merchant key (overridden in specs). */
export type OwnKeyStripeFactory = (restrictedKey: string) => StripeClient;
export const OWN_KEY_STRIPE_FACTORY = Symbol('OWN_KEY_STRIPE_FACTORY');

export const defaultStripeFactory: OwnKeyStripeFactory = (key) =>
  new Stripe(key, {
    maxNetworkRetries: 1,
    timeout: 20000,
    appInfo: { name: 'ShopsDoor' },
  });

/** Client cache: short TTL so other API instances pick up changes fast. */
const CLIENT_TTL_MS = 60_000;
const CLIENT_CACHE_MAX = 200;
// Own-key save / verify / remove lease (withLock). The lease outlives the
// slowest flow (checks + webhook + a domain registration per host).
const LOCK_LEASE_MS = 120_000;
const LOCK_WAIT_MS = 10_000;
const LOCK_POLL_MS = 500;
/** No repeated "key revoked" emails within this window. */
const REVOKED_NOTICE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Upper bound of payment method domains registered per store. */
const MAX_DOMAINS = 20;
/** How long a replaced key (and its webhook endpoint) stays readable. */
export const PREVIOUS_KEY_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;
/** Owner settings page of the own-key card (email button target). */
const OWN_KEY_SETTINGS_PATH = '/creator/settings?tab=payments#own-stripe-key';

/** In-app "key stopped working" notice, per UI locale. */
const REVOKED_NOTICE: Record<string, { title: string; body: string }> = {
  en: {
    title: 'Your Stripe key stopped working',
    body: 'Stripe rejected the restricted key of your store. Card payments are paused until you connect a new key in Settings > Payments.',
  },
  ar: {
    title: 'مفتاح Stripe الخاص بك توقف عن العمل',
    body: 'رفض Stripe المفتاح المقيّد لمتجرك. تم إيقاف مدفوعات البطاقات مؤقتاً حتى تربط مفتاحاً جديداً من الإعدادات > المدفوعات.',
  },
  tr: {
    title: 'Stripe anahtarınız çalışmayı durdurdu',
    body: 'Stripe mağazanızın kısıtlı anahtarını reddetti. Ayarlar > Ödemeler bölümünden yeni bir anahtar bağlayana kadar kart ödemeleri duraklatıldı.',
  },
  de: {
    title: 'Ihr Stripe-Schlüssel funktioniert nicht mehr',
    body: 'Stripe hat den eingeschränkten Schlüssel Ihres Shops abgelehnt. Kartenzahlungen sind pausiert, bis Sie unter Einstellungen > Zahlungen einen neuen Schlüssel verbinden.',
  },
  fr: {
    title: 'Votre clé Stripe ne fonctionne plus',
    body: "Stripe a refusé la clé restreinte de votre boutique. Les paiements par carte sont suspendus jusqu'à ce que vous connectiez une nouvelle clé dans Paramètres > Paiements.",
  },
  sv: {
    title: 'Din Stripe-nyckel slutade fungera',
    body: 'Stripe avvisade butikens begränsade nyckel. Kortbetalningar är pausade tills du kopplar en ny nyckel under Inställningar > Betalningar.',
  },
};

export function revokedNoticeText(locale: string | null | undefined): {
  title: string;
  body: string;
} {
  const key = String(locale ?? 'en').toLowerCase().split('-')[0];
  return REVOKED_NOTICE[key] ?? REVOKED_NOTICE.en;
}

/** previous_* columns of a store without a retained key. */
const PREVIOUS_CLEARED = {
  previous_restricted_key_enc: null,
  previous_key_fingerprint: null,
  previous_webhook_endpoint_id: null,
  previous_webhook_secret_enc: null,
  previous_until: null,
};

interface StoredPermissions {
  checks?: Checks;
  pi_write_check?: 'test_create' | 'live_hint' | null;
}

interface OwnerStore {
  id: string;
  slug: string;
  custom_domain: string | null;
  store_type: StoreType;
  currency: string | null;
}

export interface SaveOwnKeyInput {
  publishable_key: string;
  restricted_key: string;
}

/**
 * Owner's own Stripe account for INDEPENDENT stores (restricted key +
 * publishable key). Implements the OwnKeyApi contract for the payment flow
 * and the owner endpoints (save / verify / remove). Secrets are stored
 * encrypted and never returned or logged.
 */
@Injectable()
export class OwnKeyService implements OwnKeyApi {
  private readonly logger = new Logger(OwnKeyService.name);
  // Keyed by store id (current key) and `<storeId>#prev` (replaced key).
  private readonly clients = new Map<
    string,
    { entry: OwnKeyClientEntry; expires: number }
  >();
  private readonly factory: OwnKeyStripeFactory;

  constructor(
    private readonly prisma: PrismaService,
    private readonly crypto: CryptoService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationsService,
    private readonly audit: SecurityAuditService,
    private readonly revalidation: RevalidationService,
    private readonly storeApps: StoreAppsService,
    @Optional()
    @Inject(OWN_KEY_STRIPE_FACTORY)
    factory?: OwnKeyStripeFactory,
  ) {
    this.factory = factory ?? defaultStripeFactory;
  }

  // ── OwnKeyApi (payment flow) ────────────────────────────────────────────

  async getStatus(storeId: string): Promise<OwnKeyStatus | null> {
    const row = await this.prisma.storeStripeKeys.findUnique({
      where: { store_id: storeId },
    });
    return row ? this.toStatus(row) : null;
  }

  async isActive(
    storeId: string,
    opts: { allowTest?: boolean } = {},
  ): Promise<boolean> {
    const row = await this.prisma.storeStripeKeys.findUnique({
      where: { store_id: storeId },
      select: {
        status: true,
        livemode: true,
        store: { select: { store_type: true } },
      },
    });
    return (
      !!row &&
      row.status === 'ACTIVE' &&
      row.store.store_type === StoreType.INDEPENDENT &&
      (row.livemode || opts.allowTest === true)
    );
  }

  async getMode(
    storeId: string,
  ): Promise<{ status: OwnKeyState; livemode: boolean } | null> {
    const row = await this.prisma.storeStripeKeys.findUnique({
      where: { store_id: storeId },
      select: { status: true, livemode: true },
    });
    return row
      ? { status: row.status as OwnKeyState, livemode: row.livemode }
      : null;
  }

  async getPublishableKey(storeId: string): Promise<string | null> {
    const row = await this.prisma.storeStripeKeys.findUnique({
      where: { store_id: storeId },
      select: { publishable_key: true, status: true },
    });
    return row && row.status === 'ACTIVE' ? row.publishable_key : null;
  }

  async getClient(storeId: string): Promise<StripeClient> {
    return (await this.getClientEntry(storeId)).client;
  }

  async getClientEntry(
    storeId: string,
    opts: { fingerprint?: string | null } = {},
  ): Promise<OwnKeyClientEntry> {
    const wanted = opts.fingerprint ?? null;
    // Cached current key, unless the order names another key.
    const current = this.cached(storeId);
    if (current && (!wanted || current.fingerprint === wanted)) return current;
    const prevCached = wanted ? this.cached(`${storeId}#prev`) : null;
    if (prevCached && prevCached.fingerprint === wanted) return prevCached;

    const row = await this.prisma.storeStripeKeys.findUnique({
      where: { store_id: storeId },
      select: {
        status: true,
        livemode: true,
        restricted_key_enc: true,
        key_fingerprint: true,
        previous_restricted_key_enc: true,
        previous_key_fingerprint: true,
        previous_until: true,
      },
    });
    // An order paid with the replaced key reads it back with that key
    // while it is retained (read-only: reconcile, refund sync, webhooks).
    if (
      row &&
      wanted &&
      row.previous_key_fingerprint === wanted &&
      row.previous_restricted_key_enc &&
      row.previous_until &&
      row.previous_until.getTime() > Date.now()
    ) {
      const prevKey = this.crypto.decrypt(row.previous_restricted_key_enc);
      if (prevKey) {
        const entry: OwnKeyClientEntry = {
          client: this.factory(prevKey),
          fingerprint: wanted,
          previous: true,
          livemode: prevKey.startsWith('rk_live_'),
        };
        this.remember(`${storeId}#prev`, entry);
        return entry;
      }
    }
    const key =
      row && row.status === 'ACTIVE'
        ? this.crypto.decrypt(row.restricted_key_enc)
        : null;
    if (!row || !key) {
      throw new ConflictException({
        code: OWN_KEY_ERRORS.NOT_ACTIVE,
        message: 'The store has no active Stripe key.',
      });
    }
    const entry: OwnKeyClientEntry = {
      client: this.factory(key),
      fingerprint: row.key_fingerprint ?? keyFingerprint(key),
      previous: false,
      livemode: row.livemode,
    };
    this.remember(storeId, entry);
    return entry;
  }

  private cached(cacheKey: string): OwnKeyClientEntry | null {
    const hit = this.clients.get(cacheKey);
    if (!hit) return null;
    this.clients.delete(cacheKey);
    if (hit.expires <= Date.now()) return null;
    // Refresh recency (Map keeps insertion order -> oldest first).
    this.clients.set(cacheKey, hit);
    return hit.entry;
  }

  private remember(cacheKey: string, entry: OwnKeyClientEntry): void {
    this.clients.set(cacheKey, { entry, expires: Date.now() + CLIENT_TTL_MS });
    while (this.clients.size > CLIENT_CACHE_MAX) {
      const oldest = this.clients.keys().next().value;
      if (oldest === undefined) break;
      this.clients.delete(oldest);
    }
  }

  /** Signing secret of the store's webhook endpoint (any status). */
  async getWebhookSecret(storeId: string): Promise<string | null> {
    const row = await this.prisma.storeStripeKeys.findUnique({
      where: { store_id: storeId },
      select: { webhook_secret_enc: true },
    });
    return row?.webhook_secret_enc
      ? this.crypto.decrypt(row.webhook_secret_enc)
      : null;
  }

  async getWebhookSecrets(storeId: string): Promise<string[]> {
    const row = await this.prisma.storeStripeKeys.findUnique({
      where: { store_id: storeId },
      select: {
        webhook_secret_enc: true,
        previous_webhook_secret_enc: true,
        previous_until: true,
      },
    });
    if (!row) return [];
    const out: string[] = [];
    const current = row.webhook_secret_enc
      ? this.crypto.decrypt(row.webhook_secret_enc)
      : null;
    if (current) out.push(current);
    if (row.previous_until && row.previous_until.getTime() <= Date.now()) {
      // Retention is over: drop the old key + endpoint (lazy, best effort).
      void this.cleanupPrevious(storeId).catch(() => undefined);
    } else if (row.previous_webhook_secret_enc) {
      const prev = this.crypto.decrypt(row.previous_webhook_secret_enc);
      if (prev && prev !== current) out.push(prev);
    }
    return out;
  }

  invalidate(storeId: string): void {
    this.clients.delete(storeId);
    this.clients.delete(`${storeId}#prev`);
  }

  /**
   * Drops an expired previous key: wipes the previous_* columns, then
   * best-effort deletes the webhook endpoint left on its account. The
   * conditional update makes concurrent cleanups harmless.
   */
  async cleanupPrevious(storeId: string): Promise<boolean> {
    const row = await this.prisma.storeStripeKeys.findUnique({
      where: { store_id: storeId },
      select: {
        previous_restricted_key_enc: true,
        previous_webhook_endpoint_id: true,
        previous_until: true,
        webhook_endpoint_id: true,
      },
    });
    if (!row?.previous_until || row.previous_until.getTime() > Date.now()) {
      return false;
    }
    const wiped = await this.prisma.storeStripeKeys.updateMany({
      where: { store_id: storeId, previous_until: row.previous_until },
      data: PREVIOUS_CLEARED,
    });
    if (wiped.count === 0) return false;
    this.clients.delete(`${storeId}#prev`);
    const prevKey = row.previous_restricted_key_enc
      ? this.crypto.decrypt(row.previous_restricted_key_enc)
      : null;
    // Only that one endpoint: when both keys belong to the same account a
    // sweep by metadata would also delete the current endpoint.
    if (
      prevKey &&
      row.previous_webhook_endpoint_id &&
      row.previous_webhook_endpoint_id !== row.webhook_endpoint_id
    ) {
      await this.factory(prevKey)
        .webhookEndpoints.del(row.previous_webhook_endpoint_id)
        .catch(() => undefined);
    }
    return true;
  }

  /**
   * A merchant-key call returned 401: NEEDS_RECONNECT, then (once per 24h)
   * an in-app notification + email to the owner and an audit row. The
   * status flip is a conditional update, so concurrent calls notify once.
   * `fingerprint` names the key the failing client was built from: the
   * flip only happens while that key is still the current one (the update
   * is also pinned to the encrypted key it read), so a late 401 of an old
   * client never disables a key the owner connected meanwhile.
   */
  async markRevoked(
    storeId: string,
    reason: string,
    fingerprint?: string | null,
  ): Promise<void> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - REVOKED_NOTICE_WINDOW_MS);
    const data = {
      status: 'NEEDS_RECONNECT',
      last_error_code: OWN_KEY_ERRORS.INVALID_OR_REVOKED,
      last_check_at: now,
    };
    let notify = false;
    try {
      const row = await this.prisma.storeStripeKeys.findUnique({
        where: { store_id: storeId },
        select: { restricted_key_enc: true, key_fingerprint: true },
      });
      if (!row) return;
      if (fingerprint) {
        const current =
          row.key_fingerprint ??
          keyFingerprint(this.crypto.decrypt(row.restricted_key_enc) ?? '');
        if (current !== fingerprint) {
          this.logger.warn(
            `Ignoring a 401 for store ${storeId}: it came from a key that is no longer the current one`,
          );
          return;
        }
      }
      this.invalidate(storeId);
      const pinned = {
        store_id: storeId,
        restricted_key_enc: row.restricted_key_enc,
      };
      const flipped = await this.prisma.storeStripeKeys.updateMany({
        where: { ...pinned, status: 'ACTIVE' },
        data,
      });
      notify = flipped.count > 0;
      if (!notify) {
        const again = await this.prisma.storeStripeKeys.updateMany({
          where: {
            ...pinned,
            status: 'NEEDS_RECONNECT',
            OR: [{ last_check_at: null }, { last_check_at: { lt: cutoff } }],
          },
          data,
        });
        notify = again.count > 0;
      }
    } catch (err) {
      this.logger.error(`markRevoked(${storeId}) failed: ${safeMessage(err)}`);
      return;
    }
    if (!notify) return;

    const safeReason = redactSecrets(reason || 'unknown').slice(0, 120);
    this.logger.warn(
      `Stripe key of store ${storeId} rejected (401): ${safeReason}`,
    );
    void this.revalidation.revalidateStoreById(storeId).catch(() => undefined);

    const store = await this.prisma.store
      .findUnique({
        where: { id: storeId },
        select: {
          name: true,
          creator: {
            select: { user: { select: { id: true, email: true } } },
          },
        },
      })
      .catch(() => null);
    const owner = store?.creator?.user;
    if (!owner) return;

    const locale = await this.audit.localeFor(owner.id);
    const notice = revokedNoticeText(locale);
    await this.notifications
      .create(owner.id, 'stripe_key_needs_reconnect', notice.title, notice.body, {
        store_id: storeId,
        code: OWN_KEY_ERRORS.INVALID_OR_REVOKED,
        url: OWN_KEY_SETTINGS_PATH,
      })
      .catch((err: unknown) =>
        this.logger.warn(`Revoked-key notification failed: ${safeMessage(err)}`),
      );
    await this.audit.record({
      actor: { id: null, email: 'system' },
      action: 'payment_keys.stripe_own_key.revoked',
      targetType: 'store',
      targetId: storeId,
      targetLabel: store?.name ?? null,
      fields: [`reason: ${safeReason}`],
    });
    this.audit.alert(
      [owner.email],
      'stripe_own_key_revoked',
      { actorEmail: owner.email, actionUrl: this.settingsUrl() },
      locale,
    );
  }

  /** DASHBOARD_URL + the own-key card of the payments settings. */
  private settingsUrl(): string {
    const base = (
      this.config.get<string>('DASHBOARD_URL') || 'http://localhost:3002'
    ).replace(/\/+$/, '');
    return `${base}${OWN_KEY_SETTINGS_PATH}`;
  }

  // ── Owner endpoints ─────────────────────────────────────────────────────

  async getMine(userId: string): Promise<OwnKeyStatus | null> {
    const store = await this.ownStore(userId, false);
    return store ? this.getStatus(store.id) : null;
  }

  /**
   * Cheap checks before the re-auth prompt consumes a 2FA code: key
   * prefixes / mode and that the caller owns an INDEPENDENT store.
   */
  async assertCanSave(userId: string, input: SaveOwnKeyInput): Promise<void> {
    validateKeyPair(input.publishable_key, input.restricted_key);
    await this.ownStore(userId, true);
  }

  /** PUT: validate, verify on Stripe, set up webhook + domains, save. */
  async saveMine(userId: string, input: SaveOwnKeyInput): Promise<OwnKeyStatus> {
    const { publishable, restricted, mode } = validateKeyPair(
      input.publishable_key,
      input.restricted_key,
    );
    const store = (await this.ownStore(userId, true))!;
    return this.withLock(store.id, async () => {
      await this.cleanupPrevious(store.id).catch(() => false);
      const existing = await this.prisma.storeStripeKeys.findUnique({
        where: { store_id: store.id },
      });
      const oldKey = existing
        ? this.crypto.decrypt(existing.restricted_key_enc)
        : null;
      const client = this.factory(restricted);

      const run = await this.guardStripe(() =>
        this.runChecks(client, store, mode, existing),
      );
      if (run.missing.length) {
        throw ownKeyError(
          OWN_KEY_ERRORS.MISSING_PERMISSIONS,
          'The key is missing required permissions.',
          { missing: run.missing, permissions: this.checklist(run.checks) },
        );
      }
      if (run.unknownRequired) {
        throw new ServiceUnavailableException({
          code: OWN_KEY_ERRORS.STRIPE_UNAVAILABLE,
          message: 'Stripe could not be reached to verify the key. Try again.',
          permissions: this.checklist(run.checks),
        });
      }

      const sameKey = oldKey === restricted;
      const webhook = await this.guardStripe(() =>
        ensureWebhookEndpoint(client, {
          storeId: store.id,
          url: this.webhookUrl(store.id),
          knownEndpointId: existing?.webhook_endpoint_id ?? null,
          haveSecret: !!existing?.webhook_secret_enc,
        }),
      ).catch((err: unknown) => {
        if (this.codeOf(err) === OWN_KEY_ERRORS.MISSING_PERMISSIONS) {
          const checks: Checks = { ...run.checks, webhook_write: 'missing' };
          throw ownKeyError(
            OWN_KEY_ERRORS.MISSING_PERMISSIONS,
            'The key is missing required permissions.',
            { missing: missingRequired(checks), permissions: this.checklist(checks) },
          );
        }
        throw err;
      });

      const now = new Date();
      const fingerprint = keyFingerprint(restricted);
      const webhookSecretEnc = webhook.secret
        ? this.crypto.encrypt(webhook.secret)
        : (existing?.webhook_secret_enc ?? null);
      // A different key (another account, or test <-> live) replaces the
      // current one, which stays readable for PREVIOUS_KEY_RETENTION_MS so
      // its orders can still be reconciled / refund-synced, and its webhook
      // endpoint is left in place so late events (async payments, refunds)
      // still arrive and verify. Cleaned up lazily once expired.
      let previous: Record<string, unknown> = {};
      if (existing && oldKey && !sameKey) {
        const keptEndpoint =
          existing.webhook_endpoint_id &&
          existing.webhook_endpoint_id !== webhook.endpointId
            ? existing.webhook_endpoint_id
            : null;
        // A key replaced twice within the window: the oldest one goes now
        // (its own endpoint only, never a sweep of the account).
        const olderKey = existing.previous_restricted_key_enc
          ? this.crypto.decrypt(existing.previous_restricted_key_enc)
          : null;
        if (
          olderKey &&
          existing.previous_webhook_endpoint_id &&
          existing.previous_webhook_endpoint_id !== webhook.endpointId &&
          existing.previous_webhook_endpoint_id !== keptEndpoint
        ) {
          await this.factory(olderKey)
            .webhookEndpoints.del(existing.previous_webhook_endpoint_id)
            .catch(() => undefined);
        }
        previous = {
          previous_restricted_key_enc: existing.restricted_key_enc,
          previous_key_fingerprint:
            existing.key_fingerprint ?? keyFingerprint(oldKey),
          previous_webhook_endpoint_id: keptEndpoint,
          previous_webhook_secret_enc: keptEndpoint
            ? existing.webhook_secret_enc
            : null,
          previous_until: new Date(now.getTime() + PREVIOUS_KEY_RETENTION_MS),
        };
      }

      const data = {
        publishable_key: publishable,
        restricted_key_enc: this.crypto.encrypt(restricted)!,
        key_last4: restricted.slice(-4),
        key_fingerprint: fingerprint,
        livemode: mode === 'live',
        account_id:
          run.account_id ?? (sameKey ? (existing?.account_id ?? null) : null),
        status: 'ACTIVE',
        permissions: {
          checks: run.checks,
          pi_write_check: run.pi_write_check,
        } as Prisma.InputJsonValue,
        webhook_endpoint_id: webhook.endpointId,
        webhook_secret_enc: webhookSecretEnc,
        payment_method_domains: run.domains as Prisma.InputJsonValue,
        verified_at: now,
        last_check_at: now,
        last_error_code: null,
        ...previous,
      };
      const row = await this.prisma.storeStripeKeys.upsert({
        where: { store_id: store.id },
        create: { store_id: store.id, ...data },
        update: data,
      });
      this.invalidate(store.id);
      void this.revalidation
        .revalidateStoreById(store.id)
        .catch(() => undefined);
      return this.toStatus(row);
    });
  }

  /**
   * POST verify: re-runs the checks, the webhook repair and the domains with
   * the stored key. Always answers with the resulting status (the outcome
   * is in status / last_error_code / permissions) except 404 without a key.
   */
  async verifyMine(userId: string): Promise<OwnKeyStatus> {
    const store = (await this.ownStore(userId, true))!;
    return this.withLock(store.id, async () => {
      await this.cleanupPrevious(store.id).catch(() => false);
      const existing = await this.prisma.storeStripeKeys.findUnique({
        where: { store_id: store.id },
      });
      const key = existing
        ? this.crypto.decrypt(existing.restricted_key_enc)
        : null;
      if (!existing || !key) {
        throw new NotFoundException({
          code: OWN_KEY_ERRORS.NOT_FOUND,
          message: 'No Stripe key is connected.',
        });
      }
      const mode: KeyMode = existing.livemode ? 'live' : 'test';
      const client = this.factory(key);
      const now = new Date();
      let update: Prisma.StoreStripeKeysUpdateInput = {
        last_check_at: now,
        ...(existing.key_fingerprint
          ? {}
          : { key_fingerprint: keyFingerprint(key) }),
      };
      try {
        const run = await this.guardStripe(() =>
          this.runChecks(client, store, mode, existing),
        );
        update = {
          ...update,
          account_id: run.account_id ?? existing.account_id,
          permissions: {
            checks: run.checks,
            pi_write_check: run.pi_write_check,
          } as Prisma.InputJsonValue,
          payment_method_domains: run.domains as Prisma.InputJsonValue,
        };
        if (run.missing.length) {
          update.status = 'NEEDS_RECONNECT';
          update.last_error_code = OWN_KEY_ERRORS.MISSING_PERMISSIONS;
        } else if (run.unknownRequired) {
          update.last_error_code = OWN_KEY_ERRORS.STRIPE_UNAVAILABLE;
        } else {
          const webhook = await this.guardStripe(() =>
            ensureWebhookEndpoint(client, {
              storeId: store.id,
              url: this.webhookUrl(store.id),
              knownEndpointId: existing.webhook_endpoint_id,
              haveSecret: !!existing.webhook_secret_enc,
            }),
          );
          update.webhook_endpoint_id = webhook.endpointId;
          if (webhook.secret) {
            update.webhook_secret_enc = this.crypto.encrypt(webhook.secret);
          }
          update.status = 'ACTIVE';
          update.verified_at = now;
          update.last_error_code = null;
        }
      } catch (err) {
        const code = this.codeOf(err);
        update.last_error_code = code;
        if (code === OWN_KEY_ERRORS.INVALID_OR_REVOKED) {
          update.status = 'NEEDS_RECONNECT';
        }
      }
      const row = await this.prisma.storeStripeKeys.update({
        where: { store_id: store.id },
        data: update,
      });
      this.invalidate(store.id);
      if (row.status !== existing.status) {
        void this.revalidation
          .revalidateStoreById(store.id)
          .catch(() => undefined);
      }
      return this.toStatus(row);
    });
  }

  /** DELETE: best-effort removal of our webhook endpoint, then wipe. */
  async removeMine(userId: string): Promise<{ removed: boolean }> {
    const store = await this.ownStore(userId, false);
    if (!store) return { removed: false };
    return this.withLock(store.id, async () => {
      const existing = await this.prisma.storeStripeKeys.findUnique({
        where: { store_id: store.id },
      });
      if (!existing) return { removed: false };
      const key = this.crypto.decrypt(existing.restricted_key_enc);
      if (key) {
        await deleteWebhookEndpoint(
          this.factory(key),
          existing.webhook_endpoint_id,
          store.id,
        );
      }
      // The endpoint left on a replaced key's account goes too (by id only).
      const prevKey = existing.previous_restricted_key_enc
        ? this.crypto.decrypt(existing.previous_restricted_key_enc)
        : null;
      if (
        prevKey &&
        existing.previous_webhook_endpoint_id &&
        existing.previous_webhook_endpoint_id !== existing.webhook_endpoint_id
      ) {
        await this.factory(prevKey)
          .webhookEndpoints.del(existing.previous_webhook_endpoint_id)
          .catch(() => undefined);
      }
      await this.prisma.storeStripeKeys.deleteMany({
        where: { store_id: store.id },
      });
      this.invalidate(store.id);
      void this.revalidation
        .revalidateStoreById(store.id)
        .catch(() => undefined);
      return { removed: true };
    });
  }

  /** Admin store detail: status and booleans only, never key material. */
  async adminSummary(storeId: string) {
    const row = await this.prisma.storeStripeKeys.findUnique({
      where: { store_id: storeId },
    });
    if (!row) {
      return {
        configured: false,
        status: null,
        livemode: null,
        webhook_ok: false,
        permissions_ok: false,
        wallet_domains_ok: false,
        verified_at: null,
        last_check_at: null,
        last_error_code: null,
      };
    }
    const s = this.toStatus(row);
    const domains = Object.values(s.payment_method_domains);
    return {
      configured: true,
      status: s.status,
      livemode: s.livemode,
      webhook_ok: s.webhook_ok,
      permissions_ok: missingRequired(s.permissions).length === 0,
      wallet_domains_ok:
        domains.length > 0 &&
        domains.every((d) => !d.error && d.apple_pay === 'active'),
      verified_at: s.verified_at,
      last_check_at: s.last_check_at,
      last_error_code: s.last_error_code,
    };
  }

  // ── Internals ───────────────────────────────────────────────────────────

  /** Every public host of the store, for payment method domains. */
  async storeHosts(store: {
    id: string;
    slug: string;
    custom_domain: string | null;
  }): Promise<string[]> {
    const out = new Set<string>();
    const valid = (h: string) =>
      h.includes('.') &&
      !/^\d+(\.\d+){3}$/.test(h) &&
      !/(^|\.)(localhost|local|test|internal)$/.test(h) &&
      /^[a-z0-9.-]+$/.test(h);

    const platform = platformHosts(process.env as Record<string, string>);
    const bases = new Set(platform.map((h) => h.replace(/^www\./, '')));
    for (const base of bases) {
      const host = `${store.slug}.${base}`.toLowerCase();
      if (valid(base)) out.add(host);
    }

    const { storefront_hosts } = await loadStorefrontHosts(
      { prisma: this.prisma, storeApps: this.storeApps },
      store,
    ).catch(() => ({ storefront_hosts: [] as string[] }));
    for (const raw of storefront_hosts) {
      const host = raw.toLowerCase();
      if (!valid(host)) continue;
      out.add(host);
      // Apex and www are separate payment method domains.
      if (host.startsWith('www.')) out.add(host.slice(4));
      else if (host.split('.').length === 2) out.add(`www.${host}`);
    }
    return [...out].filter(valid).slice(0, MAX_DOMAINS);
  }

  private async runChecks(
    client: StripeClient,
    store: OwnerStore,
    mode: KeyMode,
    existing: StoreStripeKeys | null,
  ) {
    const currency = await this.currencyOf(store);
    const perms = await checkPermissions(client, mode, currency);
    if (perms.livemode !== null && perms.livemode !== (mode === 'live')) {
      throw ownKeyError(
        OWN_KEY_ERRORS.MODE_MISMATCH,
        'The key mode does not match the account mode reported by Stripe.',
      );
    }
    let domains: Record<string, Record<string, string>> =
      (existing?.payment_method_domains as Record<
        string,
        Record<string, string>
      >) ?? {};
    if (perms.checks.payment_method_domain_write !== 'missing') {
      const hosts = await this.storeHosts(store);
      const res = await registerDomains(client, hosts);
      domains = res.domains;
      if (res.permissionMissing) {
        perms.checks.payment_method_domain_write = 'missing';
      }
    }
    const missing = missingRequired(perms.checks);
    const unknownRequired =
      perms.unavailable &&
      ALL_PERMISSIONS.some(
        (p) => p !== 'dispute_read' && perms.checks[p] === 'unknown',
      );
    return { ...perms, domains, missing, unknownRequired };
  }

  /** Maps raw Stripe errors to our codes; never lets a secret through. */
  private async guardStripe<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof HttpException) throw err;
      if (isRevokedKeyError(err)) throw invalidKeyError();
      this.logger.warn(`Stripe call failed: ${safeMessage(err)}`);
      throw new ServiceUnavailableException({
        code: OWN_KEY_ERRORS.STRIPE_UNAVAILABLE,
        message: 'Stripe could not be reached to verify the key. Try again.',
      });
    }
  }

  private codeOf(err: unknown): string {
    if (err instanceof HttpException) {
      const res = err.getResponse() as { code?: unknown };
      if (res && typeof res.code === 'string') return res.code;
    }
    return OWN_KEY_ERRORS.STRIPE_UNAVAILABLE;
  }

  /** Full checklist (every permission present, unknown when not checked). */
  private checklist(checks: Checks): Record<OwnKeyPermission, OwnKeyCheck> {
    const out = {} as Record<OwnKeyPermission, OwnKeyCheck>;
    for (const p of ALL_PERMISSIONS) out[p] = checks[p] ?? 'unknown';
    return out;
  }

  private webhookUrl(storeId: string): string {
    const base =
      this.config.get<string>('PUBLIC_API_URL') || 'http://localhost:3001';
    return webhookUrlFor(base, storeId);
  }

  private async currencyOf(store: OwnerStore): Promise<string> {
    const cfg = await this.prisma.platformConfig
      .findFirst({ select: { default_currency: true } })
      .catch(() => null);
    return resolveStoreCurrency(store, cfg?.default_currency);
  }

  /**
   * The caller's store. With `strict`, a missing store is 404 and a
   * non-INDEPENDENT store 400 OWN_KEY_INDEPENDENT_ONLY.
   */
  private async ownStore(
    userId: string,
    strict: boolean,
  ): Promise<OwnerStore | null> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: {
        store: {
          select: {
            id: true,
            slug: true,
            custom_domain: true,
            store_type: true,
            currency: true,
          },
        },
      },
    });
    const store = creator?.store ?? null;
    if (!store) {
      if (strict) throw new NotFoundException('Store not found');
      return null;
    }
    if (strict && store.store_type !== StoreType.INDEPENDENT) {
      throw ownKeyError(
        OWN_KEY_ERRORS.INDEPENDENT_ONLY,
        'Only independent stores can connect their own Stripe account.',
      );
    }
    return store;
  }

  /**
   * Serializes save / verify / remove per store across API instances with a
   * short DB lease (`Store.stripe_key_lock_until`): one atomic conditional
   * UPDATE takes it, the finally block hands it back. No DB transaction or
   * pooled connection is held while the Stripe calls run. The Store row is
   * used (not StoreStripeKeys) because the first save has no key row yet.
   * The lease expires on its own after LOCK_LEASE_MS, so a crashed instance
   * never blocks the store for long; a waiter polls for up to LOCK_WAIT_MS
   * and then gets 409 OWN_KEY_BUSY.
   */
  private async withLock<T>(storeId: string, fn: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_WAIT_MS;
    let token: Date | null = null;
    for (;;) {
      const now = new Date();
      // Millisecond token: release only clears OUR lease.
      const until = new Date(now.getTime() + LOCK_LEASE_MS);
      const taken = await this.prisma.store.updateMany({
        where: {
          id: storeId,
          OR: [
            { stripe_key_lock_until: null },
            { stripe_key_lock_until: { lt: now } },
          ],
        },
        data: { stripe_key_lock_until: until },
      });
      if (taken.count === 1) {
        token = until;
        break;
      }
      if (Date.now() >= deadline) {
        throw new ConflictException({
          code: OWN_KEY_ERRORS.BUSY,
          message:
            'Another change to this Stripe key is in progress. Try again in a moment.',
        });
      }
      await new Promise((r) => setTimeout(r, LOCK_POLL_MS));
    }
    try {
      return await fn();
    } finally {
      await this.prisma.store
        .updateMany({
          where: { id: storeId, stripe_key_lock_until: token },
          data: { stripe_key_lock_until: null },
        })
        .catch((err: unknown) =>
          this.logger.warn(
            `Could not release the own-key lease of store ${storeId}: ${safeMessage(err)}`,
          ),
        );
    }
  }

  toStatus(row: StoreStripeKeys): OwnKeyStatus {
    const stored = (row.permissions ?? {}) as StoredPermissions;
    return {
      status: row.status as OwnKeyState,
      livemode: row.livemode,
      key_last4: row.key_last4,
      account_id: row.account_id,
      permissions: stored.checks ?? {},
      webhook_ok: !!row.webhook_endpoint_id && !!row.webhook_secret_enc,
      payment_method_domains: (row.payment_method_domains ?? {}) as Record<
        string,
        Record<string, string>
      >,
      verified_at: row.verified_at?.toISOString() ?? null,
      last_check_at: row.last_check_at?.toISOString() ?? null,
      last_error_code: row.last_error_code,
      pi_write_check: stored.pi_write_check ?? null,
    };
  }
}
