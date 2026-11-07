import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { CryptoService } from '../../../common/crypto/crypto.service';
import { OwnKeyService, revokedNoticeText } from './own-key.service';
import { securityAlertEmail } from '../../mail/templates';
import { OWN_KEY_ERRORS, type StripeClient } from './own-key.types';
import {
  keyFingerprint,
  permissionsFromMessage,
  redactSecrets,
  validateKeyPair,
  webhookUrlFor,
} from './own-key.util';
import {
  PINNED_API_VERSION,
  checkPermissions,
  ensureWebhookEndpoint,
  registerDomains,
} from './own-key.verifier';
import { PaymentKeysGuardService } from '../../security/payment-keys-guard.service';
import { OwnKeyController } from './own-key.controller';

const RK = 'rk_' + 'test_' + 'TESTFIXTURE'.padEnd(24, 'x') + '1234';
const PK = 'pk_test_51AbCdEfGhIjKlMnOpQrStUv5678';
const WHSEC = 'whsec_SuperSecretSigningValue99';
const STORE_ID = 'store-1';

function stripeErr(statusCode: number, message = 'err', code?: string) {
  return Object.assign(new Error(message), { statusCode, code });
}

/** Promise of a Stripe list page that is also auto-paging iterable. */
function listOf<T>(items: T[]) {
  const p = Promise.resolve({ data: items, has_more: false });
  return Object.assign(p, {
    async *[Symbol.asyncIterator]() {
      for (const i of items) yield i;
    },
  });
}

interface FakeEndpoint {
  id: string;
  url: string;
  enabled_events: string[];
  metadata: Record<string, string>;
  api_version: string;
  status: string;
}

/** Minimal merchant Stripe account: every call is a jest.fn. */
function fakeStripe(opts: { endpoints?: FakeEndpoint[] } = {}) {
  const endpoints = opts.endpoints ?? [];
  let seq = 0;
  const domainOf = (name: string) => ({
    id: `pmd_${name}`,
    domain_name: name,
    enabled: true,
    apple_pay: { status: 'inactive' },
    google_pay: { status: 'active' },
    link: { status: 'active' },
  });
  return {
    endpoints,
    balance: { retrieve: jest.fn(async () => ({ livemode: false })) },
    charges: { list: jest.fn(() => listOf([])) },
    disputes: { list: jest.fn(() => listOf([])) },
    paymentIntents: {
      list: jest.fn(() => listOf([])),
      create: jest.fn(
        async (_params: Record<string, unknown>) => ({ id: 'pi_check' }),
      ),
      cancel: jest.fn(async () => ({ id: 'pi_check', status: 'canceled' })),
    },
    webhookEndpoints: {
      list: jest.fn(() => listOf([...endpoints])),
      create: jest.fn(async (params: Record<string, unknown>) => {
        const e = {
          id: `we_${++seq}`,
          url: params.url as string,
          enabled_events: params.enabled_events as string[],
          metadata: params.metadata as Record<string, string>,
          api_version: params.api_version as string,
          status: 'enabled',
        };
        endpoints.push(e);
        return { ...e, secret: WHSEC };
      }),
      update: jest.fn(async (id: string) => ({ id })),
      del: jest.fn(async (id: string) => {
        const i = endpoints.findIndex((e) => e.id === id);
        if (i >= 0) endpoints.splice(i, 1);
        return { id, deleted: true };
      }),
    },
    paymentMethodDomains: {
      list: jest.fn(
        (_params: { domain_name?: string }) =>
          listOf([] as Array<Record<string, unknown>>),
      ),
      create: jest.fn(async (p: { domain_name: string }) =>
        domainOf(p.domain_name),
      ),
      update: jest.fn(),
      validate: jest.fn(async (id: string) => ({
        ...domainOf(id.replace('pmd_', '')),
        apple_pay: { status: 'active' },
      })),
    },
  };
}
type FakeStripe = ReturnType<typeof fakeStripe>;
const asClient = (f: FakeStripe) => f as unknown as StripeClient;

// ── Pure helpers ───────────────────────────────────────────────────────────

describe('own-key key validation', () => {
  it('accepts a restricted + publishable pair of the same mode', () => {
    expect(validateKeyPair(` ${PK} `, RK)).toEqual({
      publishable: PK,
      restricted: RK,
      mode: 'test',
    });
  });

  it('rejects sk_ keys outright', () => {
    expect(() => validateKeyPair(PK, 'sk_test_abcdefghijkl1234')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: OWN_KEY_ERRORS.SECRET_KEY_REJECTED,
        }),
      }),
    );
  });

  it('rejects a wrong prefix and a mode mismatch', () => {
    const codeOf = (fn: () => unknown) => {
      try {
        fn();
      } catch (e) {
        return (e as { response: { code: string } }).response.code;
      }
      return null;
    };
    expect(codeOf(() => validateKeyPair(RK, RK))).toBe(
      OWN_KEY_ERRORS.INVALID_PREFIX,
    );
    expect(
      codeOf(() =>
        validateKeyPair('pk_live_51AbCdEfGhIjKl', 'rk_test_51AbCdEfGhIjKl'),
      ),
    ).toBe(OWN_KEY_ERRORS.MODE_MISMATCH);
  });

  it('redacts rk_/sk_/whsec_ secrets in messages', () => {
    const out = redactSecrets(
      `bad ${RK} and sk_live_abc123 and ${WHSEC} end`,
    );
    expect(out).not.toContain('AbCdEf');
    expect(out).not.toContain('abc123');
    expect(out).not.toContain('SuperSecret');
    expect(out).toContain('rk_test_***');
  });

  it('maps rak_* permission names to our ids', () => {
    expect(
      permissionsFromMessage(
        "Having the 'rak_charge_read' or 'rak_webhook_write' permission would allow this.",
      ).sort(),
    ).toEqual(['charge_read', 'webhook_write']);
  });

  it('builds the webhook url under /api', () => {
    expect(webhookUrlFor('https://api.example.com/', 's1')).toBe(
      'https://api.example.com/api/payments/webhook/store/s1',
    );
  });
});

// ── Verifier ───────────────────────────────────────────────────────────────

describe('own-key permission checks', () => {
  it('401 maps to OWN_KEY_INVALID_OR_REVOKED', async () => {
    const s = fakeStripe();
    s.balance.retrieve.mockRejectedValueOnce(stripeErr(401, 'Expired key'));
    await expect(
      checkPermissions(asClient(s), 'test', 'EUR'),
    ).rejects.toMatchObject({
      response: { code: OWN_KEY_ERRORS.INVALID_OR_REVOKED },
    });
  });

  it('403 marks the permission missing and reads the account id', async () => {
    const s = fakeStripe();
    s.charges.list.mockImplementationOnce(() => {
      throw stripeErr(
        403,
        "The provided key 'rk_test_***1234' does not have the required permissions for this endpoint on account 'acct_1TestAcct99'. Having the 'rak_charge_read' permission would allow this request to continue.",
      );
    });
    s.disputes.list.mockImplementationOnce(() => {
      throw stripeErr(403, 'no rak_dispute_read');
    });
    const res = await checkPermissions(asClient(s), 'test', 'SEK');
    expect(res.checks).toEqual({
      balance_read: 'ok',
      charge_read: 'missing',
      payment_intent_write: 'ok',
      webhook_write: 'ok',
      payment_method_domain_write: 'ok',
      dispute_read: 'missing',
    });
    expect(res.account_id).toBe('acct_1TestAcct99');
  });

  it('test mode creates and cancels a check PaymentIntent', async () => {
    const s = fakeStripe();
    const res = await checkPermissions(asClient(s), 'test', 'SEK');
    expect(s.paymentIntents.create).toHaveBeenCalledWith(
      expect.objectContaining({
        currency: 'sek',
        metadata: { purpose: 'shopsdoor_key_check' },
      }),
    );
    expect(s.paymentIntents.cancel).toHaveBeenCalledWith('pi_check');
    expect(res.pi_write_check).toBe('test_create');
  });

  it('live mode never creates a PI: 400 = granted (hint), 403 = missing', async () => {
    const ok = fakeStripe();
    ok.balance.retrieve.mockResolvedValue({ livemode: true });
    ok.paymentIntents.create.mockRejectedValueOnce(stripeErr(400, 'Invalid'));
    const r1 = await checkPermissions(asClient(ok), 'live', 'EUR');
    expect(r1.pi_write_check).toBe('live_hint');
    expect(r1.checks.payment_intent_write).toBe('ok');
    expect(ok.paymentIntents.create.mock.calls[0][0]).toMatchObject({
      amount: -1,
    });

    const no = fakeStripe();
    no.paymentIntents.create.mockRejectedValueOnce(
      stripeErr(403, 'rak_payment_intent_write'),
    );
    const r2 = await checkPermissions(asClient(no), 'live', 'EUR');
    expect(r2.checks.payment_intent_write).toBe('missing');
  });
});

describe('own-key webhook endpoint', () => {
  const url = 'https://api.example.com/api/payments/webhook/store/store-1';
  const ours = (id: string): FakeEndpoint => ({
    id,
    url,
    enabled_events: ['payment_intent.succeeded'],
    metadata: { platform: 'shopsdoor', store_id: STORE_ID },
    api_version: PINNED_API_VERSION,
    status: 'enabled',
  });

  it('reuses our endpoint when we hold its secret (update, no create)', async () => {
    const s = fakeStripe({ endpoints: [ours('we_old')] });
    const res = await ensureWebhookEndpoint(asClient(s), {
      storeId: STORE_ID,
      url,
      knownEndpointId: 'we_old',
      haveSecret: true,
    });
    expect(res).toEqual({ endpointId: 'we_old', secret: null });
    expect(s.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(s.webhookEndpoints.update).toHaveBeenCalledWith(
      'we_old',
      expect.objectContaining({ url }),
    );
  });

  it('deletes and recreates when the secret is unknown', async () => {
    const s = fakeStripe({ endpoints: [ours('we_old')] });
    const res = await ensureWebhookEndpoint(asClient(s), {
      storeId: STORE_ID,
      url,
      knownEndpointId: null,
      haveSecret: false,
    });
    expect(s.webhookEndpoints.del).toHaveBeenCalledWith('we_old');
    expect(s.webhookEndpoints.create).toHaveBeenCalledWith(
      expect.objectContaining({
        connect: false,
        api_version: PINNED_API_VERSION,
        metadata: { platform: 'shopsdoor', store_id: STORE_ID },
      }),
    );
    expect(res.secret).toBe(WHSEC);
  });

  it('refuses with OWN_KEY_WEBHOOK_LIMIT at 16 foreign endpoints', async () => {
    const foreign = Array.from({ length: 16 }, (_, i) => ({
      ...ours(`we_f${i}`),
      url: `https://other.example/${i}`,
      metadata: {},
    }));
    const s = fakeStripe({ endpoints: foreign });
    await expect(
      ensureWebhookEndpoint(asClient(s), {
        storeId: STORE_ID,
        url,
        knownEndpointId: null,
        haveSecret: false,
      }),
    ).rejects.toMatchObject({
      response: { code: OWN_KEY_ERRORS.WEBHOOK_LIMIT },
    });
    expect(s.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(s.webhookEndpoints.del).not.toHaveBeenCalled();
  });

  it('403 on create maps to OWN_KEY_MISSING_PERMISSIONS', async () => {
    const s = fakeStripe();
    s.webhookEndpoints.create.mockRejectedValueOnce(
      stripeErr(403, 'rak_webhook_write'),
    );
    await expect(
      ensureWebhookEndpoint(asClient(s), {
        storeId: STORE_ID,
        url,
        knownEndpointId: null,
        haveSecret: false,
      }),
    ).rejects.toMatchObject({
      response: {
        code: OWN_KEY_ERRORS.MISSING_PERMISSIONS,
        missing: ['webhook_write'],
      },
    });
  });
});

describe('own-key payment method domains', () => {
  it('a failing host does not fail the others', async () => {
    const s = fakeStripe();
    s.paymentMethodDomains.create.mockImplementation(
      async (p: { domain_name: string }) => {
        if (p.domain_name === 'bad.example.com') {
          throw stripeErr(400, 'invalid domain', 'domain_invalid');
        }
        return {
          id: `pmd_${p.domain_name}`,
          domain_name: p.domain_name,
          enabled: true,
          apple_pay: { status: 'inactive' },
          google_pay: { status: 'active' },
          link: { status: 'active' },
        };
      },
    );
    const res = await registerDomains(asClient(s), [
      'shop.example.com',
      'bad.example.com',
    ]);
    expect(res.permissionMissing).toBe(false);
    expect(res.domains['shop.example.com']).toMatchObject({
      apple_pay: 'active',
      google_pay: 'active',
    });
    expect(res.domains['bad.example.com']).toEqual({ error: 'domain_invalid' });
  });

  it('reuses an existing domain instead of creating it', async () => {
    const s = fakeStripe();
    s.paymentMethodDomains.list.mockImplementation(() =>
      listOf([
        {
          id: 'pmd_x',
          domain_name: 'x.example.com',
          enabled: true,
          apple_pay: { status: 'active' },
        },
      ]),
    );
    const res = await registerDomains(asClient(s), ['x.example.com']);
    expect(s.paymentMethodDomains.create).not.toHaveBeenCalled();
    expect(s.paymentMethodDomains.validate).not.toHaveBeenCalled();
    expect(res.domains['x.example.com']).toEqual({ apple_pay: 'active' });
  });
});

// ── Service ────────────────────────────────────────────────────────────────

type Row = Record<string, unknown> & { store_id: string };

function makeDeps(storeType: 'INDEPENDENT' | 'MARKETPLACE' = 'INDEPENDENT') {
  const rows = new Map<string, Row>();
  const store = {
    id: STORE_ID,
    slug: 'acme',
    custom_domain: 'acme.se',
    store_type: storeType,
    currency: 'SEK',
    name: 'Acme',
  };
  const matches = (row: Row, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => {
      if (k === 'OR') {
        return (v as Record<string, unknown>[]).some((w) => matches(row, w));
      }
      if (v && typeof v === 'object' && 'lt' in (v as object)) {
        const cur = row[k] as Date | null;
        return !!cur && cur < (v as { lt: Date }).lt;
      }
      if (v === null) return row[k] === null || row[k] === undefined;
      return row[k] === v;
    });
  const lockCalls: string[] = [];
  // Store.stripe_key_lock_until lease of save / verify / remove.
  const lease: { until: Date | null } = { until: null };
  const prisma = {
    rows,
    lockCalls,
    lease,
    $transaction: jest.fn(),
    creator: {
      findUnique: jest.fn(async () => ({ store })),
    },
    store: {
      findUnique: jest.fn(async () => ({
        name: store.name,
        creator: { user: { id: 'owner-1', email: 'owner@example.com' } },
      })),
      updateMany: jest.fn(
        async (args: {
          where: {
            id: string;
            OR?: unknown[];
            stripe_key_lock_until?: Date | null;
          };
          data: { stripe_key_lock_until: Date | null };
        }) => {
          if (args.where.OR) {
            // Acquire: free or expired lease only.
            if (lease.until && lease.until.getTime() >= Date.now()) {
              return { count: 0 };
            }
            lockCalls.push(`acquire:${args.where.id}`);
          } else {
            // Release: only the holder's own token.
            if (lease.until !== args.where.stripe_key_lock_until) {
              return { count: 0 };
            }
            lockCalls.push(`release:${args.where.id}`);
          }
          lease.until = args.data.stripe_key_lock_until;
          return { count: 1 };
        },
      ),
    },
    platformConfig: {
      findFirst: jest.fn(async () => ({ default_currency: 'EUR' })),
    },
    storeDomain: { findMany: jest.fn(async () => []) },
    storeStripeKeys: {
      findUnique: jest.fn(async ({ where }: { where: { store_id: string } }) => {
        const r = rows.get(where.store_id);
        return r ? { ...r, store: { store_type: store.store_type } } : null;
      }),
      upsert: jest.fn(
        async (args: {
          where: { store_id: string };
          create: Row;
          update: Row;
        }) => {
          const prev = rows.get(args.where.store_id);
          const next = prev
            ? { ...prev, ...args.update }
            : { ...args.create, id: 'k1' };
          rows.set(args.where.store_id, next);
          return next;
        },
      ),
      update: jest.fn(
        async (args: { where: { store_id: string }; data: Row }) => {
          const next = { ...rows.get(args.where.store_id)!, ...args.data };
          rows.set(args.where.store_id, next);
          return next;
        },
      ),
      updateMany: jest.fn(
        async (args: { where: Record<string, unknown>; data: Row }) => {
          let count = 0;
          for (const [id, r] of rows) {
            if (matches(r, args.where)) {
              rows.set(id, { ...r, ...args.data });
              count++;
            }
          }
          return { count };
        },
      ),
      deleteMany: jest.fn(async ({ where }: { where: { store_id: string } }) => {
        const had = rows.delete(where.store_id);
        return { count: had ? 1 : 0 };
      }),
    },
  };
  const config = new ConfigService({
    ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
    PUBLIC_API_URL: 'https://api.example.com',
  });
  const crypto = new CryptoService(config);
  void crypto.onModuleInit();
  const notifications = { create: jest.fn(async () => ({})) };
  const audit = {
    record: jest.fn(async () => undefined),
    alert: jest.fn(),
    localeFor: jest.fn(async () => 'sv'),
  };
  const revalidation = { revalidateStoreById: jest.fn(async () => undefined) };
  const storeApps = { isEnabled: jest.fn(async () => false) };
  const clients: FakeStripe[] = [];
  const keysSeen: string[] = [];
  let next: FakeStripe | null = null;
  const factory = jest.fn((key: string) => {
    keysSeen.push(key);
    const c = next ?? fakeStripe();
    next = null;
    clients.push(c);
    return asClient(c);
  });
  const service = new OwnKeyService(
    prisma as never,
    crypto,
    config,
    notifications as never,
    audit as never,
    revalidation as never,
    storeApps as never,
    factory,
  );
  return {
    service,
    prisma,
    crypto,
    notifications,
    audit,
    factory,
    clients,
    keysSeen,
    useNext: (c: FakeStripe) => {
      next = c;
    },
  };
}

describe('OwnKeyService', () => {
  it('saves encrypted, returns no secret and logs none', async () => {
    const logs: string[] = [];
    const spies = (['log', 'warn', 'error', 'debug'] as const).map((m) =>
      jest
        .spyOn(Logger.prototype, m)
        .mockImplementation((msg: unknown) => void logs.push(String(msg))),
    );
    const d = makeDeps();
    const status = await d.service.saveMine('owner-1', {
      publishable_key: PK,
      restricted_key: RK,
    });
    const row = d.prisma.rows.get(STORE_ID)!;
    expect(row.restricted_key_enc).not.toBe(RK);
    expect(d.crypto.decrypt(row.restricted_key_enc as string)).toBe(RK);
    expect(d.crypto.decrypt(row.webhook_secret_enc as string)).toBe(WHSEC);
    expect(row.key_last4).toBe('1234');
    expect(status).toMatchObject({
      status: 'ACTIVE',
      livemode: false,
      key_last4: '1234',
      webhook_ok: true,
      pi_write_check: 'test_create',
      last_error_code: null,
    });
    const json = JSON.stringify(status) + logs.join('\n');
    expect(json).not.toContain(RK);
    expect(json).not.toContain(WHSEC);
    expect(json).not.toContain('enc');
    // Platform subdomain + custom apex + www registered as domains.
    expect(Object.keys(status.payment_method_domains).sort()).toEqual(
      expect.arrayContaining(['acme.se', 'www.acme.se']),
    );
    spies.forEach((s) => s.mockRestore());
  });

  it('refuses non-INDEPENDENT stores', async () => {
    const d = makeDeps('MARKETPLACE');
    await expect(
      d.service.assertCanSave('owner-1', {
        publishable_key: PK,
        restricted_key: RK,
      }),
    ).rejects.toMatchObject({
      response: { code: OWN_KEY_ERRORS.INDEPENDENT_ONLY },
    });
  });

  it('missing permissions -> 400 with a full checklist, nothing saved', async () => {
    const d = makeDeps();
    const s = fakeStripe();
    s.webhookEndpoints.list.mockImplementation(() => {
      throw stripeErr(403, 'rak_webhook_write');
    });
    d.useNext(s);
    await expect(
      d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK }),
    ).rejects.toMatchObject({
      response: {
        code: OWN_KEY_ERRORS.MISSING_PERMISSIONS,
        missing: ['webhook_write'],
        permissions: expect.objectContaining({
          webhook_write: 'missing',
          charge_read: 'ok',
          dispute_read: 'ok',
        }),
      },
    });
    expect(d.prisma.rows.size).toBe(0);
  });

  it('a revoked key (401) is rejected without saving', async () => {
    const d = makeDeps();
    const s = fakeStripe();
    s.balance.retrieve.mockRejectedValue(stripeErr(401, `Invalid API Key provided: ${RK}`));
    d.useNext(s);
    const err = await d.service
      .saveMine('owner-1', { publishable_key: PK, restricted_key: RK })
      .then(
        () => null,
        (e: unknown) => e as { response: { code: string; message: string } },
      );
    if (!err) throw new Error('expected a rejection');
    expect(err.response.code).toBe(OWN_KEY_ERRORS.INVALID_OR_REVOKED);
    expect(JSON.stringify(err.response)).not.toContain(RK);
    expect(d.prisma.rows.size).toBe(0);
  });

  it('caches the client and invalidates on save / remove / markRevoked', async () => {
    const d = makeDeps();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    const calls = () => d.factory.mock.calls.length;
    const base = calls();
    const c1 = await d.service.getClient(STORE_ID);
    const c2 = await d.service.getClient(STORE_ID);
    expect(c1).toBe(c2);
    expect(calls()).toBe(base + 1);

    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    const c3 = await d.service.getClient(STORE_ID);
    expect(c3).not.toBe(c1);

    await d.service.markRevoked(STORE_ID, '401');
    await expect(d.service.getClient(STORE_ID)).rejects.toMatchObject({
      response: { code: OWN_KEY_ERRORS.NOT_ACTIVE },
    });
    expect(await d.service.isActive(STORE_ID)).toBe(false);
  });

  it('second save with the same key reuses the webhook endpoint', async () => {
    const d = makeDeps();
    const account = fakeStripe();
    // Same merchant account behind both saves.
    const shared = () => {
      const c = fakeStripe({ endpoints: account.endpoints });
      d.useNext(c);
      return c;
    };
    shared();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    const second = shared();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    expect(second.webhookEndpoints.create).not.toHaveBeenCalled();
    expect(account.endpoints).toHaveLength(1);
    expect(d.prisma.rows.get(STORE_ID)!.webhook_endpoint_id).toBe('we_1');
  });

  it('markRevoked notifies once (idempotent within 24h)', async () => {
    const d = makeDeps();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    await Promise.all([
      d.service.markRevoked(STORE_ID, `401 ${RK}`),
      d.service.markRevoked(STORE_ID, '401'),
    ]);
    await d.service.markRevoked(STORE_ID, '401');
    expect(d.prisma.rows.get(STORE_ID)!.status).toBe('NEEDS_RECONNECT');
    expect(d.notifications.create).toHaveBeenCalledTimes(1);
    expect(d.audit.alert).toHaveBeenCalledTimes(1);
    expect(d.audit.alert).toHaveBeenCalledWith(
      ['owner@example.com'],
      'stripe_own_key_revoked',
      expect.anything(),
      'sv',
    );
    expect(d.audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'payment_keys.stripe_own_key.revoked' }),
    );
    expect(JSON.stringify(d.audit.record.mock.calls)).not.toContain(RK);

    // After 24h the owner is reminded again.
    d.prisma.rows.get(STORE_ID)!.last_check_at = new Date(
      Date.now() - 25 * 3600 * 1000,
    );
    await d.service.markRevoked(STORE_ID, '401');
    expect(d.notifications.create).toHaveBeenCalledTimes(2);
  });

  it('verify flips to NEEDS_RECONNECT on 401 and answers with the status', async () => {
    const d = makeDeps();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    const s = fakeStripe();
    s.balance.retrieve.mockRejectedValue(stripeErr(401, 'revoked'));
    d.useNext(s);
    const status = await d.service.verifyMine('owner-1');
    expect(status.status).toBe('NEEDS_RECONNECT');
    expect(status.last_error_code).toBe(OWN_KEY_ERRORS.INVALID_OR_REVOKED);
  });

  it('remove deletes our endpoint (best effort) and wipes the row', async () => {
    const d = makeDeps();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    const s = fakeStripe();
    d.useNext(s);
    expect(await d.service.removeMine('owner-1')).toEqual({ removed: true });
    expect(s.webhookEndpoints.del).toHaveBeenCalledWith('we_1');
    expect(d.prisma.rows.size).toBe(0);
    expect(await d.service.getStatus(STORE_ID)).toBeNull();
    expect(await d.service.getWebhookSecret(STORE_ID)).toBeNull();
  });

  it('getWebhookSecret decrypts the stored secret', async () => {
    const d = makeDeps();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    expect(await d.service.getWebhookSecret(STORE_ID)).toBe(WHSEC);
    expect(await d.service.getPublishableKey(STORE_ID)).toBe(PK);
  });
});

// ── Re-auth wiring ─────────────────────────────────────────────────────────

describe('own-key re-auth', () => {
  function guard(verify: jest.Mock) {
    const audit = {
      record: jest.fn(async () => undefined),
      alert: jest.fn(),
      localeFor: jest.fn(async () => 'en'),
    };
    return {
      audit,
      svc: new PaymentKeysGuardService(
        { verify } as never,
        audit as never,
      ),
    };
  }
  const user = {
    id: 'owner-1',
    email: 'owner@example.com',
    role: 'CREATOR',
  } as never;
  const meta = { ip: '1.2.3.4', userAgent: 'jest' };

  it('PUT requires password + 2FA before touching Stripe', async () => {
    const verify = jest.fn(async () => {
      throw Object.assign(new Error('REAUTH_REQUIRED'), { status: 403 });
    });
    const { svc } = guard(verify);
    const ownKey = {
      assertCanSave: jest.fn(async () => undefined),
      saveMine: jest.fn(),
    };
    const ctrl = new OwnKeyController(ownKey as never, svc);
    await expect(
      ctrl.save(
        user,
        { publishable_key: PK, restricted_key: RK } as never,
        meta,
      ),
    ).rejects.toThrow('REAUTH_REQUIRED');
    expect(verify).toHaveBeenCalledWith(
      'owner-1',
      { current_password: undefined, totp_code: undefined },
      expect.objectContaining({
        purpose: 'payment_keys.stripe_own_key.updated',
        require2fa: true,
      }),
    );
    expect(ownKey.saveMine).not.toHaveBeenCalled();
  });

  it('audits field names only and alerts the owner', async () => {
    const verify = jest.fn(async () => ({}));
    const { svc, audit } = guard(verify);
    const ownKey = {
      assertCanSave: jest.fn(async () => undefined),
      saveMine: jest.fn(async () => ({ status: 'ACTIVE' })),
      removeMine: jest.fn(async () => ({ removed: true })),
    };
    const ctrl = new OwnKeyController(ownKey as never, svc);
    await ctrl.save(
      user,
      {
        publishable_key: PK,
        restricted_key: RK,
        current_password: 'pw',
        totp_code: '123456',
      } as never,
      meta,
    );
    await ctrl.remove(user, { current_password: 'pw', totp_code: '654321' }, meta);
    const recorded = JSON.stringify(audit.record.mock.calls);
    expect(recorded).not.toContain(RK);
    expect(recorded).not.toContain(PK);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'payment_keys.stripe_own_key.removed',
        fields: ['publishable_key (cleared)', 'restricted_key (cleared)'],
      }),
    );
    expect(audit.alert).toHaveBeenCalledWith(
      ['owner@example.com'],
      'stripe_own_key_changed',
      expect.anything(),
      'en',
    );
  });
});

// ── Hardening: replaced keys, revocation race, locking, notices ─────────────

const RK_LIVE = 'rk_' + 'live_' + 'TESTFIXTURE'.padEnd(22, 'x') + '1234';
const PK_LIVE = 'pk_live_51ZyXwVuTsRqPoNmLkJiHg5432';
const WHSEC_NEW = 'whsec_NewAccountSigningValue77';

/** A live-mode merchant account on another Stripe account. */
function liveAccount() {
  const c = fakeStripe();
  c.balance.retrieve.mockResolvedValue({ livemode: true });
  c.paymentIntents.create.mockRejectedValue(stripeErr(400, 'Invalid'));
  c.webhookEndpoints.create.mockImplementation(
    async (params: Record<string, unknown>) => {
      const e = {
        id: 'we_new',
        url: params.url as string,
        enabled_events: params.enabled_events as string[],
        metadata: params.metadata as Record<string, string>,
        api_version: params.api_version as string,
        status: 'enabled',
      };
      c.endpoints.push(e);
      return { ...e, secret: WHSEC_NEW };
    },
  );
  return c;
}

describe('OwnKeyService hardening', () => {
  it('replacing the key (test -> live, other account) keeps the old key + endpoint read-only', async () => {
    const d = makeDeps();
    const first = fakeStripe();
    d.useNext(first);
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    const oldFp = keyFingerprint(RK);
    expect(d.prisma.rows.get(STORE_ID)!.key_fingerprint).toBe(oldFp);

    d.useNext(liveAccount());
    const status = await d.service.saveMine('owner-1', {
      publishable_key: PK_LIVE,
      restricted_key: RK_LIVE,
    });
    expect(status.livemode).toBe(true);
    const row = d.prisma.rows.get(STORE_ID)!;
    expect(row.key_fingerprint).toBe(keyFingerprint(RK_LIVE));
    expect(row.previous_key_fingerprint).toBe(oldFp);
    expect(d.crypto.decrypt(row.previous_restricted_key_enc as string)).toBe(RK);
    expect(row.previous_webhook_endpoint_id).toBe('we_1');
    const until = (row.previous_until as Date).getTime();
    expect(until - Date.now()).toBeGreaterThan(59 * 24 * 3600 * 1000);
    // The old endpoint was NOT deleted on the old account.
    expect(first.webhookEndpoints.del).not.toHaveBeenCalled();
    // Fingerprints never contain the key.
    expect(JSON.stringify(row)).not.toContain(RK_LIVE);

    // Both endpoints' secrets verify while the old key is retained.
    expect(await d.service.getWebhookSecrets(STORE_ID)).toEqual([
      WHSEC_NEW,
      WHSEC,
    ]);
    // An order paid with the old key reads back with the old key.
    const keysBefore = d.keysSeen.length;
    const prev = await d.service.getClientEntry(STORE_ID, { fingerprint: oldFp });
    expect(prev).toMatchObject({ previous: true, fingerprint: oldFp });
    expect(d.keysSeen.slice(keysBefore)).toEqual([RK]);
    const cur = await d.service.getClientEntry(STORE_ID);
    expect(cur).toMatchObject({ previous: false, livemode: true });
  });

  it('an expired previous key is cleaned up lazily (its endpoint only)', async () => {
    const d = makeDeps();
    const first = fakeStripe();
    d.useNext(first);
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    d.useNext(liveAccount());
    await d.service.saveMine('owner-1', {
      publishable_key: PK_LIVE,
      restricted_key: RK_LIVE,
    });
    const row = d.prisma.rows.get(STORE_ID)!;
    row.previous_until = new Date(Date.now() - 1000);
    const oldAccount = fakeStripe();
    d.useNext(oldAccount);
    expect(await d.service.cleanupPrevious(STORE_ID)).toBe(true);
    expect(oldAccount.webhookEndpoints.del).toHaveBeenCalledWith('we_1');
    expect(oldAccount.webhookEndpoints.list).not.toHaveBeenCalled();
    expect(d.prisma.rows.get(STORE_ID)!.previous_key_fingerprint).toBeNull();
    expect(await d.service.getWebhookSecrets(STORE_ID)).toEqual([WHSEC_NEW]);
    // The expired key is no longer used for its orders.
    await expect(
      d.service.getClientEntry(STORE_ID, { fingerprint: keyFingerprint(RK) }),
    ).resolves.toMatchObject({ previous: false });
  });

  it('markRevoked with the fingerprint of an OLD client never disables the new key', async () => {
    const d = makeDeps();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    d.useNext(liveAccount());
    await d.service.saveMine('owner-1', {
      publishable_key: PK_LIVE,
      restricted_key: RK_LIVE,
    });
    await d.service.markRevoked(STORE_ID, '401', keyFingerprint(RK));
    expect(d.prisma.rows.get(STORE_ID)!.status).toBe('ACTIVE');
    expect(d.notifications.create).not.toHaveBeenCalled();

    await d.service.markRevoked(STORE_ID, '401', keyFingerprint(RK_LIVE));
    expect(d.prisma.rows.get(STORE_ID)!.status).toBe('NEEDS_RECONNECT');
  });

  it('markRevoked is pinned to the key it read (a concurrent save wins)', async () => {
    const d = makeDeps();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    const real = d.prisma.storeStripeKeys.findUnique.getMockImplementation()!;
    // The key is replaced between markRevoked's read and its update.
    d.prisma.storeStripeKeys.findUnique.mockImplementationOnce(async (args) => {
      const r = await real(args);
      d.prisma.rows.get(STORE_ID)!.restricted_key_enc = 'replaced';
      return r;
    });
    await d.service.markRevoked(STORE_ID, '401', keyFingerprint(RK));
    expect(d.prisma.rows.get(STORE_ID)!.status).toBe('ACTIVE');
  });

  it('a TEST key is not active for the public checkout, only with allowTest', async () => {
    const d = makeDeps();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    expect(await d.service.isActive(STORE_ID)).toBe(false);
    expect(await d.service.isActive(STORE_ID, { allowTest: true })).toBe(true);
    expect(await d.service.getMode(STORE_ID)).toEqual({
      status: 'ACTIVE',
      livemode: false,
    });
  });

  it('save / verify / remove run under a per-store DB lease, no transaction', async () => {
    const d = makeDeps();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    await d.service.verifyMine('owner-1');
    await d.service.removeMine('owner-1');
    expect(d.prisma.$transaction).not.toHaveBeenCalled();
    expect(d.prisma.lockCalls).toEqual([
      `acquire:${STORE_ID}`,
      `release:${STORE_ID}`,
      `acquire:${STORE_ID}`,
      `release:${STORE_ID}`,
      `acquire:${STORE_ID}`,
      `release:${STORE_ID}`,
    ]);
    expect(d.prisma.lease.until).toBeNull();
  });

  it('the lease is released when the flow fails', async () => {
    const d = makeDeps();
    await expect(d.service.verifyMine('owner-1')).rejects.toBeDefined();
    expect(d.prisma.lease.until).toBeNull();
  });

  it('a held lease makes a concurrent change wait, then 409 OWN_KEY_BUSY', async () => {
    jest.useFakeTimers();
    try {
      const d = makeDeps();
      d.prisma.lease.until = new Date(Date.now() + 60_000);
      const p = d.service
        .saveMine('owner-1', { publishable_key: PK, restricted_key: RK })
        .catch((e: unknown) => e);
      await jest.advanceTimersByTimeAsync(11_000);
      const err = (await p) as { response?: { code?: string } };
      expect(err.response?.code).toBe('OWN_KEY_BUSY');
      // The holder's lease is untouched.
      expect(d.prisma.lease.until).not.toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('an expired lease (crashed instance) is taken over', async () => {
    const d = makeDeps();
    d.prisma.lease.until = new Date(Date.now() - 1000);
    await expect(
      d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK }),
    ).resolves.toMatchObject({ status: 'ACTIVE' });
    expect(d.prisma.lease.until).toBeNull();
  });

  it('the revoked notice is localized and the email links to the own-key settings', async () => {
    const d = makeDeps();
    await d.service.saveMine('owner-1', { publishable_key: PK, restricted_key: RK });
    await d.service.markRevoked(STORE_ID, '401');
    expect(d.notifications.create).toHaveBeenCalledWith(
      'owner-1',
      'stripe_key_needs_reconnect',
      revokedNoticeText('sv').title,
      revokedNoticeText('sv').body,
      expect.objectContaining({ code: OWN_KEY_ERRORS.INVALID_OR_REVOKED }),
    );
    expect(revokedNoticeText('sv').title).toContain('Stripe-nyckel');
    expect(d.audit.alert).toHaveBeenCalledWith(
      ['owner@example.com'],
      'stripe_own_key_revoked',
      expect.objectContaining({
        actionUrl: expect.stringMatching(
          /\/creator\/settings\?tab=payments#own-stripe-key$/,
        ),
      }),
      'sv',
    );
    for (const l of ['en', 'ar', 'tr', 'de', 'fr', 'sv']) {
      expect(revokedNoticeText(l).title.length).toBeGreaterThan(5);
    }
  });

  it('the revoked email renders the reconnect button in every locale', () => {
    for (const l of ['en', 'ar', 'tr', 'de', 'fr', 'sv']) {
      const mail = securityAlertEmail(
        {
          kind: 'stripe_own_key_revoked',
          actorEmail: 'owner@example.com',
          at: new Date(),
          actionUrl:
            'https://dash.example.com/creator/settings?tab=payments#own-stripe-key',
        },
        l,
      );
      expect(mail.html).toContain(
        'href="https://dash.example.com/creator/settings?tab=payments#own-stripe-key"',
      );
      expect(mail.text).toContain('own-stripe-key');
    }
    // Other alerts carry no button.
    const other = securityAlertEmail(
      {
        kind: 'stripe_own_key_changed',
        actorEmail: 'o@example.com',
        at: new Date(),
        actionUrl: 'https://x.example.com',
      },
      'en',
    );
    expect(other.html).not.toContain('https://x.example.com');
  });
});
