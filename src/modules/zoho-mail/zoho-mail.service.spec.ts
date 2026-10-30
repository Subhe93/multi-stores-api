import { ForbiddenException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { ConfigService } from '@nestjs/config';
import { StoreType } from '@prisma/client';
import { ZohoMailService } from './zoho-mail.service';
import {
  ZohoMailController,
  ZohoMailPurgeController,
} from './zoho-mail.controller';
import { signState } from './zoho-mail.state';
import { REQUIRE_APP_KEY } from '../../common/decorators';
import { RequireAppGuard } from '../../common/guards/require-app.guard';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MailService } from '../mail/mail.service';

// Zoho Mail service with stubbed Prisma / StoreApps / Crypto and a mocked
// global fetch routed by URL. Every store has its own Zoho client.

const JWT = 'jwt-secret';
const ENV: Record<string, string> = {
  PUBLIC_API_URL: 'https://api.test/',
  JWT_SECRET: JWT,
  DASHBOARD_URL: 'https://dash.test/',
};
const REDIRECT = 'https://api.test/api/zoho-mail/oauth/callback';

interface Row {
  id: string;
  store_id: string;
  region: string;
  client_id: string | null;
  client_secret: string | null;
  connected_email: string | null;
  account_id: string | null;
  from_address: string | null;
  from_name: string | null;
  available_from: unknown;
  refresh_token: string | null;
  access_token: string | null;
  access_expires_at: Date | null;
  connected_at: Date | null;
  verified_at: Date | null;
  last_error: string | null;
  last_error_detail: string | null;
  last_error_at: Date | null;
}

/** Client saved, not authorized. */
function clientRow(over: Partial<Row> = {}): Row {
  return {
    id: 'z1',
    store_id: 's1',
    region: 'zoho.com',
    client_id: 'store-cid',
    client_secret: 'enc:store-secret',
    connected_email: null,
    account_id: null,
    from_address: null,
    from_name: null,
    available_from: [],
    refresh_token: null,
    access_token: null,
    access_expires_at: null,
    connected_at: null,
    verified_at: null,
    last_error: null,
    last_error_detail: null,
    last_error_at: null,
    ...over,
  };
}

function connectedRow(over: Partial<Row> = {}): Row {
  return clientRow({
    region: 'zoho.eu',
    connected_email: 'owner@shop.se',
    account_id: '222',
    from_address: 'orders@shop.se',
    from_name: 'Shop',
    available_from: [
      { address: 'owner@shop.se', account_id: '111' },
      { address: 'orders@shop.se', account_id: '222' },
    ],
    refresh_token: 'enc:rt',
    access_token: 'enc:old-at',
    access_expires_at: new Date(Date.now() + 3600_000),
    connected_at: new Date(),
    ...over,
  });
}

interface Route {
  match: RegExp;
  respond: (init: RequestInit) => { status: number; json: unknown };
}

type FetchMock = jest.Mock<Promise<unknown>, [string, RequestInit]>;

function routeFetch(routes: Route[]): FetchMock {
  const fn = jest.fn((url: string, init: RequestInit) => {
    const r = routes.find((x) => x.match.test(url));
    const out = r ? r.respond(init) : { status: 404, json: {} };
    return Promise.resolve({
      status: out.status,
      json: () => Promise.resolve(out.json),
    });
  });
  global.fetch = fn as unknown as typeof fetch;
  return fn as unknown as FetchMock;
}

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

const ACCOUNTS = {
  data: [
    {
      accountId: '111',
      primaryEmailAddress: 'owner@shop.se',
      sendMailDetails: [{ fromAddress: 'owner@shop.se' }],
    },
    {
      accountId: '222',
      sendMailDetails: [{ fromAddress: 'orders@shop.se' }],
    },
  ],
};

function build(
  opts: {
    row?: Row | null;
    env?: Record<string, string>;
    storeType?: StoreType;
    enabled?: boolean;
  } = {},
) {
  const env = opts.env ?? ENV;
  const storeType = opts.storeType ?? StoreType.INDEPENDENT;
  let row: Row | null = opts.row === undefined ? connectedRow() : opts.row;
  const prisma = {
    storeZohoMail: {
      findUnique: jest.fn((args: { include?: unknown }) =>
        Promise.resolve(
          row
            ? args.include
              ? { ...row, store: { store_type: storeType } }
              : { ...row }
            : null,
        ),
      ),
      create: jest.fn((args: { data: Partial<Row> }) => {
        row = { ...clientRow({ client_secret: null }), ...args.data } as Row;
        return Promise.resolve(row);
      }),
      update: jest.fn((args: { data: Partial<Row> }) => {
        row = { ...(row as Row), ...args.data };
        return Promise.resolve(row);
      }),
      updateMany: jest.fn((args: { data: Partial<Row> }) => {
        if (row) row = { ...row, ...args.data };
        return Promise.resolve({ count: row ? 1 : 0 });
      }),
      deleteMany: jest.fn(() => {
        row = null;
        return Promise.resolve({ count: 1 });
      }),
    },
    store: {
      findUnique: jest.fn(() =>
        Promise.resolve({ store_type: storeType, name: 'Shop' }),
      ),
    },
  };
  const storeApps = {
    storeOfCreator: jest.fn(() =>
      Promise.resolve({ id: 's1', store_type: storeType }),
    ),
    storeIdByUser: jest.fn((u: string) =>
      Promise.resolve(u === 'u1' ? 's1' : null),
    ),
    isEnabled: jest.fn(() => Promise.resolve(opts.enabled ?? true)),
  };
  const crypto = {
    encrypt: jest.fn((v: string | null) => (v ? `enc:${v}` : null)),
    decrypt: jest.fn((v: string | null) => (v ? v.replace(/^enc:/, '') : null)),
    isEncrypted: jest.fn((v: string | null) => !!v && v.startsWith('enc:')),
  };
  const mail = { registerStoreMailProvider: jest.fn() };
  const service = new ZohoMailService(
    { get: (k: string) => env[k] } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    crypto as unknown as CryptoService,
    storeApps as unknown as StoreAppsService,
    mail as unknown as MailService,
  );
  return { service, prisma, storeApps, mail, getRow: () => row };
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
});

describe('ZohoMailService client / status / connect', () => {
  it('no row: client not configured, redirect_uri from PUBLIC_API_URL, connect → 409', async () => {
    const { service } = build({ row: null });
    expect(await service.status('u1')).toEqual(
      expect.objectContaining({
        client_configured: false,
        client_id: null,
        has_client_secret: false,
        redirect_uri: REDIRECT,
        connected: false,
        available_from: [],
      }),
    );
    await expect(service.connect('u1')).rejects.toMatchObject({
      status: 409,
      response: { code: 'ZOHO_CLIENT_NOT_CONFIGURED' },
    });
  });

  it('ZOHO_REDIRECT_URI overrides the redirect URI', async () => {
    const { service } = build({
      env: { ...ENV, ZOHO_REDIRECT_URI: 'https://x.test/cb' },
    });
    expect((await service.status('u1')).redirect_uri).toBe('https://x.test/cb');
  });

  it('saves the client with an encrypted secret, never returned', async () => {
    const { service, getRow } = build({ row: null });
    const status = await service.saveClient('u1', {
      region: 'zoho.eu',
      client_id: ' 1000.ABC ',
      client_secret: 'sec',
    });
    expect(getRow()).toMatchObject({
      region: 'zoho.eu',
      client_id: '1000.ABC',
      client_secret: 'enc:sec',
    });
    expect(status).toMatchObject({
      client_configured: true,
      client_id: '1000.ABC',
      has_client_secret: true,
      region: 'zoho.eu',
    });
    expect(JSON.stringify(status)).not.toContain('sec"');
  });

  it('rejects an unknown region and an empty client id', async () => {
    const { service } = build({ row: null });
    await expect(
      service.saveClient('u1', { region: 'evil.com', client_id: 'x' }),
    ).rejects.toMatchObject({ response: { code: 'ZOHO_MAIL_INVALID_REGION' } });
    await expect(
      service.saveClient('u1', { region: 'zoho.eu', client_id: ' ' }),
    ).rejects.toMatchObject({ response: { code: 'ZOHO_MAIL_INVALID_CLIENT' } });
  });

  it('omitted secret keeps the stored one and the connection', async () => {
    const { service, getRow } = build();
    await service.saveClient('u1', {
      region: 'zoho.eu',
      client_id: 'store-cid',
    });
    expect(getRow()).toMatchObject({
      client_secret: 'enc:store-secret',
      refresh_token: 'enc:rt',
    });
  });

  it('changing client id or region revokes and drops the token', async () => {
    const { service, getRow } = build();
    const f = routeFetch([
      { match: /token\/revoke$/, respond: () => ({ status: 200, json: {} }) },
    ]);
    const status = await service.saveClient('u1', {
      region: 'zoho.com',
      client_id: 'store-cid',
    });
    expect(f.mock.calls[0][0]).toBe(
      'https://accounts.zoho.eu/oauth/v2/token/revoke?token=rt',
    );
    expect(getRow()).toMatchObject({
      region: 'zoho.com',
      refresh_token: null,
      access_token: null,
      from_address: null,
      account_id: null,
    });
    expect(status.connected).toBe(false);
    expect(status.client_configured).toBe(true);
  });

  it('builds the authorize URL with the store client and a signed state', async () => {
    const { service } = build({ row: clientRow({ region: 'zoho.eu' }) });
    const { authorize_url } = await service.connect('u1');
    const url = new URL(authorize_url);
    expect(url.host).toBe('accounts.zoho.eu');
    expect(url.searchParams.get('client_id')).toBe('store-cid');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('state')).toMatch(/^[\w-]+\.[\w-]+$/);
    expect(authorize_url).not.toContain('store-secret');
  });

  it('status of a connected store maps available_from to addresses', async () => {
    const { service } = build();
    expect(await service.status('u1')).toMatchObject({
      client_configured: true,
      enabled: true,
      connected: true,
      region: 'zoho.eu',
      from_address: 'orders@shop.se',
      available_from: ['owner@shop.se', 'orders@shop.se'],
    });
  });

  it('marketplace store → 403 ZOHO_MAIL_REQUIRES_INDEPENDENT', async () => {
    const { service } = build({ storeType: StoreType.MARKETPLACE });
    const err = await service.status('u1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'ZOHO_MAIL_REQUIRES_INDEPENDENT',
    });
  });

  it('PUT sender validates from_address and maps its account', async () => {
    const { service, getRow } = build();
    await expect(
      service.updateSender('u1', { from_address: 'evil@x.com' }),
    ).rejects.toMatchObject({
      response: { code: 'ZOHO_MAIL_FROM_NOT_ALLOWED' },
    });
    await service.updateSender('u1', {
      from_address: 'OWNER@shop.se',
      from_name: 'New\r\nName',
    });
    expect(getRow()).toMatchObject({
      from_address: 'owner@shop.se',
      account_id: '111',
      from_name: 'New Name',
    });
  });

  it('PUT sender without a connection → 404 ZOHO_MAIL_NOT_CONNECTED', async () => {
    const { service } = build({ row: clientRow() });
    await expect(
      service.updateSender('u1', { from_address: 'a@x.se' }),
    ).rejects.toMatchObject({ response: { code: 'ZOHO_MAIL_NOT_CONNECTED' } });
  });
});

describe('ZohoMailService OAuth callback', () => {
  const state = (over: Partial<{ userId: string; storeId: string }> = {}) =>
    signState(JWT, {
      storeId: 's1',
      userId: 'u1',
      region: 'zoho.com',
      ...over,
    }).state;

  it("success: exchanges with the store's client via accounts-server DC", async () => {
    const { service, getRow } = build({ row: clientRow() });
    const f = routeFetch([
      {
        match: /^https:\/\/accounts\.zoho\.eu\/oauth\/v2\/token$/,
        respond: () => ({
          status: 200,
          json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
        }),
      },
      {
        match: /^https:\/\/mail\.zoho\.eu\/api\/accounts$/,
        respond: () => ({ status: 200, json: ACCOUNTS }),
      },
    ]);
    const target = await service.handleCallback({
      code: 'CODE',
      state: state(),
      'accounts-server': 'https://accounts.zoho.eu',
      location: 'eu',
    });
    expect(target).toBe('https://dash.test/creator/zoho-mail?connected=1');
    expect(f).toHaveBeenCalledTimes(2);
    const body = new URLSearchParams(f.mock.calls[0][1].body as string);
    expect(body.get('client_id')).toBe('store-cid');
    expect(body.get('client_secret')).toBe('store-secret');
    expect(body.get('redirect_uri')).toBe(REDIRECT);
    expect(getRow()).toMatchObject({
      region: 'zoho.eu',
      connected_email: 'owner@shop.se',
      from_address: 'owner@shop.se',
      account_id: '111',
      from_name: 'Shop',
      refresh_token: 'enc:RT',
      access_token: 'enc:AT',
      available_from: [
        { address: 'owner@shop.se', account_id: '111' },
        { address: 'orders@shop.se', account_id: '222' },
      ],
    });
  });

  it('replays of the same state are refused', async () => {
    const { service } = build({ row: clientRow() });
    routeFetch([
      {
        match: /oauth\/v2\/token$/,
        respond: () => ({
          status: 200,
          json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
        }),
      },
      {
        match: /api\/accounts$/,
        respond: () => ({ status: 200, json: ACCOUNTS }),
      },
    ]);
    const s = state();
    await service.handleCallback({ code: 'C', state: s });
    expect(await service.handleCallback({ code: 'C', state: s })).toBe(
      'https://dash.test/creator/zoho-mail?error=state_used',
    );
  });

  it('error param → ?error=access_denied without calling Zoho', async () => {
    const { service } = build({ row: clientRow() });
    const f = routeFetch([]);
    expect(
      await service.handleCallback({ error: 'access_denied', state: state() }),
    ).toBe('https://dash.test/creator/zoho-mail?error=access_denied');
    expect(
      await service.handleCallback({ error: 'whatever', state: state() }),
    ).toBe('https://dash.test/creator/zoho-mail?error=zoho_error');
    expect(f).not.toHaveBeenCalled();
  });

  it('foreign accounts-server is rejected before any token call', async () => {
    const { service } = build({ row: clientRow() });
    const f = routeFetch([]);
    expect(
      await service.handleCallback({
        code: 'C',
        state: state(),
        'accounts-server': 'https://accounts.evil.com',
      }),
    ).toBe('https://dash.test/creator/zoho-mail?error=invalid_server');
    expect(f).not.toHaveBeenCalled();
  });

  it('tampered state, other user, disabled app, missing client are refused', async () => {
    const { service } = build({ row: clientRow() });
    routeFetch([]);
    expect(
      await service.handleCallback({ code: 'C', state: `${state()}x` }),
    ).toContain('error=invalid_state');
    expect(
      await service.handleCallback({
        code: 'C',
        state: state({ userId: 'u2' }),
      }),
    ).toContain('error=not_allowed');
    const disabled = build({ row: clientRow(), enabled: false });
    expect(
      await disabled.service.handleCallback({ code: 'C', state: state() }),
    ).toContain('error=not_allowed');
    const noClient = build({ row: null });
    expect(
      await noClient.service.handleCallback({ code: 'C', state: state() }),
    ).toContain('error=client_not_configured');
    const moved = build({ row: clientRow({ region: 'zoho.in' }) });
    expect(
      await moved.service.handleCallback({ code: 'C', state: state() }),
    ).toContain('error=invalid_state');
  });

  it('an unexpected error after the exchange revokes the new token and 302s token_failed', async () => {
    const { service, prisma } = build({ row: clientRow() });
    prisma.storeZohoMail.update.mockRejectedValueOnce(new Error('db down'));
    const f = routeFetch([
      {
        match: /oauth\/v2\/token$/,
        respond: () => ({
          status: 200,
          json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
        }),
      },
      {
        match: /api\/accounts$/,
        respond: () => ({ status: 200, json: ACCOUNTS }),
      },
      { match: /token\/revoke/, respond: () => ({ status: 200, json: {} }) },
    ]);
    expect(await service.handleCallback({ code: 'C', state: state() })).toBe(
      'https://dash.test/creator/zoho-mail?error=token_failed',
    );
    const revoke = f.mock.calls.find((c) => /token\/revoke/.test(c[0]));
    expect(revoke).toBeDefined();
    expect(revoke?.[1].body as string).toContain('token=RT');
  });

  it('never throws: a missing server secret still redirects', async () => {
    const { service } = build({ row: clientRow(), env: {} });
    expect(await service.handleCallback({ code: 'C', state: 'x.y' })).toBe(
      'http://localhost:3002/creator/zoho-mail?error=token_failed',
    );
  });

  it('a token stored by a concurrent callback is revoked too', async () => {
    const { service, prisma } = build({ row: clientRow() });
    // First read: no token yet; the re-read finds one written meanwhile.
    prisma.storeZohoMail.findUnique
      .mockResolvedValueOnce({ ...clientRow() } as never)
      .mockResolvedValueOnce({
        ...clientRow({ refresh_token: 'enc:OTHER' }),
      } as never);
    const f = routeFetch([
      {
        match: /oauth\/v2\/token$/,
        respond: () => ({
          status: 200,
          json: { access_token: 'AT', refresh_token: 'RT', expires_in: 3600 },
        }),
      },
      {
        match: /api\/accounts$/,
        respond: () => ({ status: 200, json: ACCOUNTS }),
      },
      { match: /token\/revoke/, respond: () => ({ status: 200, json: {} }) },
    ]);
    expect(await service.handleCallback({ code: 'C', state: state() })).toBe(
      'https://dash.test/creator/zoho-mail?connected=1',
    );
    const revoked = f.mock.calls
      .filter((c) => /token\/revoke/.test(c[0]))
      .map((c) => c[1].body as string);
    expect(revoked).toEqual(['token=OTHER']);
  });

  it('token exchange failure → ?error=token_failed', async () => {
    const { service, getRow } = build({ row: clientRow() });
    routeFetch([
      {
        match: /oauth\/v2\/token$/,
        respond: () => ({ status: 200, json: { error: 'invalid_code' } }),
      },
    ]);
    expect(await service.handleCallback({ code: 'C', state: state() })).toBe(
      'https://dash.test/creator/zoho-mail?error=token_failed',
    );
    expect(getRow()?.refresh_token).toBeNull();
  });
});

describe('ZohoMailService sending', () => {
  const message = {
    to: 'anna@example.com',
    subject: 'Order MS-1',
    html: '<p>Thanks</p>',
    text: 'Thanks',
  };

  it('registers itself with MailService', () => {
    const { service, mail } = build();
    service.onModuleInit();
    expect(mail.registerStoreMailProvider).toHaveBeenCalledWith(service);
  });

  it('does not apply when off, not connected, no from address or marketplace', async () => {
    expect(
      await build({ enabled: false }).service.sendForStore('s1', message),
    ).toBeNull();
    expect(
      await build({ row: null }).service.sendForStore('s1', message),
    ).toBeNull();
    expect(
      await build({ row: clientRow() }).service.sendForStore('s1', message),
    ).toBeNull();
    expect(
      await build({
        row: connectedRow({ from_address: null }),
      }).service.sendForStore('s1', message),
    ).toBeNull();
    expect(
      await build({ storeType: StoreType.MARKETPLACE }).service.sendForStore(
        's1',
        message,
      ),
    ).toBeNull();
  });

  it('uploads attachments first then sends to the from address account', async () => {
    const { service } = build();
    const f = routeFetch([
      {
        match: /messages\/attachments\?fileName=/,
        respond: () => ({
          status: 200,
          json: {
            data: {
              storeName: 'S',
              attachmentPath: '/a',
              attachmentName: 'f.pdf',
            },
          },
        }),
      },
      {
        match: /\/api\/accounts\/222\/messages$/,
        respond: () => ({ status: 200, json: { status: { code: 200 } } }),
      },
    ]);
    const res = await service.sendForStore('s1', {
      ...message,
      attachments: [
        {
          filename: 'f.pdf',
          content: Buffer.from('%PDF'),
          contentType: 'application/pdf',
        },
      ],
    });
    expect(res).toEqual({ sent: true, host: 'mail.zoho.eu' });
    expect(f.mock.calls.map((c) => c[0])).toEqual([
      'https://mail.zoho.eu/api/accounts/222/messages/attachments?fileName=f.pdf',
      'https://mail.zoho.eu/api/accounts/222/messages',
    ]);
    const init = f.mock.calls[1][1];
    expect(headersOf(init).Authorization).toBe('Zoho-oauthtoken old-at');
    expect(JSON.parse(init.body as string)).toEqual({
      fromAddress: 'Shop <orders@shop.se>',
      toAddress: 'anna@example.com',
      subject: 'Order MS-1',
      content: '<p>Thanks</p>',
      mailFormat: 'html',
      attachments: [
        { storeName: 'S', attachmentPath: '/a', attachmentName: 'f.pdf' },
      ],
    });
  });

  it("refreshes once on 401 with the store's client and retries", async () => {
    const { service, getRow } = build();
    let sends = 0;
    const f = routeFetch([
      {
        match: /oauth\/v2\/token$/,
        respond: () => ({
          status: 200,
          json: { access_token: 'new-at', expires_in: 3600 },
        }),
      },
      {
        match: /\/messages$/,
        respond: () => {
          sends += 1;
          return sends === 1
            ? {
                status: 401,
                json: { data: { errorCode: 'INVALID_OAUTHTOKEN' } },
              }
            : { status: 200, json: {} };
        },
      },
    ]);
    const res = await service.sendForStore('s1', message);
    expect(res).toEqual({ sent: true, host: 'mail.zoho.eu' });
    expect(sends).toBe(2);
    const tokenCall = f.mock.calls.find((c) => /oauth\/v2\/token$/.test(c[0]));
    const body = new URLSearchParams(tokenCall?.[1].body as string);
    expect(body.get('refresh_token')).toBe('rt');
    expect(body.get('client_id')).toBe('store-cid');
    expect(body.get('client_secret')).toBe('store-secret');
    expect(headersOf(f.mock.calls[2][1]).Authorization).toBe(
      'Zoho-oauthtoken new-at',
    );
    expect(getRow()?.access_token).toBe('enc:new-at');
  });

  it('refreshes an expired cached token before sending', async () => {
    const { service } = build({
      row: connectedRow({ access_expires_at: new Date(Date.now() - 1000) }),
    });
    const f = routeFetch([
      {
        match: /oauth\/v2\/token$/,
        respond: () => ({
          status: 200,
          json: { access_token: 'fresh', expires_in: 3600 },
        }),
      },
      { match: /\/messages$/, respond: () => ({ status: 200, json: {} }) },
    ]);
    await service.sendForStore('s1', message);
    expect(f.mock.calls[0][0]).toBe('https://accounts.zoho.eu/oauth/v2/token');
  });

  it('a failure records last_error and reports it (MailService then falls back)', async () => {
    const { service, getRow } = build();
    routeFetch([
      {
        match: /\/messages$/,
        respond: () => ({
          status: 500,
          json: { status: { description: 'Internal Error' } },
        }),
      },
    ]);
    const res = await service.sendForStore('s1', message);
    expect(res).toMatchObject({ sent: false, host: 'mail.zoho.eu' });
    expect(getRow()?.last_error).toBe('ZOHO_MAIL_SEND_FAILED');
    expect(getRow()?.last_error_detail).toContain('HTTP 500');
    expect(getRow()?.last_error_at).toBeInstanceOf(Date);
  });

  it('attachment over 10 MB fails before any upload', async () => {
    const { service } = build();
    const f = routeFetch([]);
    const res = await service.sendForStore('s1', {
      ...message,
      attachments: [
        {
          filename: 'big.pdf',
          content: Buffer.alloc(10 * 1024 * 1024 + 1),
          contentType: 'application/pdf',
        },
      ],
    });
    expect(res).toMatchObject({ sent: false });
    expect(f).not.toHaveBeenCalled();
  });

  it('test sets verified_at on success and returns the error otherwise', async () => {
    const ok = build();
    routeFetch([
      { match: /\/messages$/, respond: () => ({ status: 200, json: {} }) },
    ]);
    expect(await ok.service.sendTest('u1', 'me@x.se')).toEqual({ ok: true });
    expect(ok.getRow()?.verified_at).toBeInstanceOf(Date);

    const bad = build();
    routeFetch([
      { match: /\/messages$/, respond: () => ({ status: 400, json: {} }) },
    ]);
    const res = await bad.service.sendTest('u1', 'me@x.se');
    expect(res.ok).toBe(false);
    expect(res.error).toBe('ZOHO_MAIL_SEND_FAILED');
    expect(bad.getRow()?.last_error_detail).toContain('HTTP 400');
  });

  it('disconnect revokes (best effort) and deletes everything', async () => {
    const { service, getRow } = build();
    const f = routeFetch([
      { match: /token\/revoke$/, respond: () => ({ status: 500, json: {} }) },
    ]);
    const status = await service.disconnect('u1');
    expect(f.mock.calls[0][1].body).toBe('token=rt');
    expect(getRow()).toBeNull();
    expect(status).toMatchObject({
      connected: false,
      client_configured: false,
    });
  });

  it('revoked grant: tokens dropped, RECONNECT_REQUIRED, later sends skip Zoho', async () => {
    const { service, getRow } = build({
      row: connectedRow({ access_expires_at: new Date(Date.now() - 1000) }),
    });
    const f = routeFetch([
      {
        match: /oauth\/v2\/token$/,
        respond: () => ({ status: 200, json: { error: 'invalid_code' } }),
      },
    ]);
    const res = await service.sendForStore('s1', message);
    expect(res).toMatchObject({ sent: false });
    expect(getRow()).toMatchObject({
      refresh_token: null,
      access_token: null,
      access_expires_at: null,
      last_error: 'ZOHO_MAIL_RECONNECT_REQUIRED',
    });
    expect(await service.status('u1')).toMatchObject({
      connected: false,
      client_configured: true,
      last_error: 'ZOHO_MAIL_RECONNECT_REQUIRED',
    });
    f.mockClear();
    expect(await service.sendForStore('s1', message)).toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('disconnect works while the app is disabled (purge path)', async () => {
    const { service, getRow } = build({ enabled: false });
    routeFetch([
      { match: /token\/revoke/, respond: () => ({ status: 200, json: {} }) },
    ]);
    const status = await service.disconnect('u1');
    expect(getRow()).toBeNull();
    expect(status).toMatchObject({ connected: false, enabled: false });
  });

  it('disconnect with keep_client keeps the client only', async () => {
    const { service, getRow } = build();
    routeFetch([
      { match: /token\/revoke$/, respond: () => ({ status: 200, json: {} }) },
    ]);
    const status = await service.disconnect('u1', true);
    expect(getRow()).toMatchObject({
      client_id: 'store-cid',
      client_secret: 'enc:store-secret',
      refresh_token: null,
      from_address: null,
    });
    expect(status).toMatchObject({ connected: false, client_configured: true });
  });
});

describe('ZohoMailController guards', () => {
  it('runs JWT, roles and app guards with @RequireApp(zoho_mail)', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ZohoMailController,
    ) as unknown[];
    expect(guards).toHaveLength(3);
    expect(guards[2]).toBe(RequireAppGuard);
    expect(Reflect.getMetadata(REQUIRE_APP_KEY, ZohoMailController)).toBe(
      'zoho_mail',
    );
  });

  it('DELETE lives on the purge controller without RequireAppGuard', () => {
    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ZohoMailPurgeController,
    ) as unknown[];
    expect(guards).toHaveLength(2);
    expect(guards).not.toContain(RequireAppGuard);
    expect(
      Reflect.getMetadata(REQUIRE_APP_KEY, ZohoMailPurgeController),
    ).toBeUndefined();
    expect('disconnect' in ZohoMailController.prototype).toBe(false);
    expect(typeof ZohoMailPurgeController.prototype.disconnect).toBe(
      'function',
    );
  });

  it('app disabled → 403 STORE_APP_NOT_ENABLED from RequireAppGuard', async () => {
    const guard = new RequireAppGuard(new Reflector(), {
      isEnabled: jest.fn(() => Promise.resolve(false)),
      storeIdByUser: jest.fn(() => Promise.resolve('s1')),
    } as unknown as StoreAppsService);
    const handler = () => undefined;
    const ctx = {
      getHandler: () => handler,
      getClass: () => ZohoMailController,
      switchToHttp: () => ({
        getRequest: () => ({ params: {}, user: { id: 'u1' } }),
      }),
    } as unknown as ExecutionContext;
    const err = await guard.canActivate(ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: 'STORE_APP_NOT_ENABLED',
    });
  });
});
