import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { StoresService } from './stores.service';
import { UpdateStoreDto } from './dto/store.dto';
import { ownerStorePayload, publicStoreRow } from './store-secrets';
import { ProvidersService } from '../providers/providers.service';
import { PRISMA_GLOBAL_OMIT } from '../../prisma/prisma.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';
import type { OrdersService } from '../orders/orders.service';
import type { StoreAppsService } from '../store-apps/store-apps.service';
import type { MarketsService } from '../markets/markets.service';
import type { MarketsContextService } from '../markets/markets-context.service';
import type { RedirectsService } from '../redirects/redirects.service';
import type { CryptoService } from '../../common/crypto/crypto.service';

// Meta Conversions API token on the store settings: write-only, stored
// encrypted, never part of any payload. The owner / admin payloads carry
// `meta_capi_token_set`; nobody else learns even that.

const TOKEN = 'EAAGm0PX4ZCpsBAsecretTokenValue123';
const ENCRYPTED = `v2:enc(${TOKEN.length})`;

/** A stored row as the owner queries read it (token column opted in). */
function storedRow(over: Record<string, unknown> = {}) {
  return {
    id: 's1',
    slug: 'namez',
    creator_id: 'c1',
    custom_domain: null,
    meta_pixel_id: '123456789012345',
    meta_capi_token: ENCRYPTED,
    meta_test_event_code: 'TEST12345',
    consent_required: true,
    ...over,
  };
}

function build(row = storedRow()) {
  let current: Record<string, unknown> = { ...row };
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: {
      findUnique: jest.fn(() => Promise.resolve({ ...current })),
      findFirst: jest.fn(() => Promise.resolve(null)),
      update: jest.fn((args: { data: Record<string, unknown> }) => {
        current = { ...current, ...args.data };
        return Promise.resolve({ ...current });
      }),
    },
  };
  const crypto = {
    encrypt: jest.fn((plain: string) => `v2:enc(${plain.length})`),
  };
  const service = new StoresService(
    prisma as unknown as PrismaService,
    {
      revalidateStoreBySlug: jest.fn(() => Promise.resolve()),
    } as unknown as RevalidationService,
    {} as OrdersService,
    {
      isEnabled: jest.fn(() => Promise.resolve(false)),
    } as unknown as StoreAppsService,
    {} as MarketsService,
    { invalidate: jest.fn() } as unknown as MarketsContextService,
    {
      versionFor: jest.fn(() => Promise.resolve(null)),
    } as unknown as RedirectsService,
    undefined,
    undefined,
    crypto as unknown as CryptoService,
  );
  return { service, prisma, crypto };
}

function updateData(prisma: ReturnType<typeof build>['prisma'], call = 0) {
  return (
    prisma.store.update.mock.calls[call] as unknown as [
      { data: Record<string, unknown>; omit?: unknown },
    ]
  )[0];
}

/** Neither the token nor its ciphertext appears anywhere in the payload. */
function expectNoToken(payload: unknown) {
  const json = JSON.stringify(payload);
  expect(json).not.toContain(TOKEN);
  expect(json).not.toContain(ENCRYPTED);
  expect(json).not.toContain('"meta_capi_token"');
}

describe('global Prisma omit', () => {
  it('keeps the token (and the order tracking context) out of every default read', () => {
    expect(PRISMA_GLOBAL_OMIT).toEqual({
      store: { meta_capi_token: true },
      order: { tracking_context: true },
    });
  });
});

describe('store payload helpers', () => {
  it('owner payload: the token becomes meta_capi_token_set', () => {
    const payload = ownerStorePayload(storedRow());
    expect(payload).toMatchObject({
      meta_capi_token_set: true,
      meta_test_event_code: 'TEST12345',
    });
    expectNoToken(payload);
    expect(
      ownerStorePayload(storedRow({ meta_capi_token: null }))
        .meta_capi_token_set,
    ).toBe(false);
    // A row read without the column (the default) reports "not set".
    expect(ownerStorePayload({ id: 's1' })).toEqual({
      id: 's1',
      meta_capi_token_set: false,
    });
  });

  it('public row: no token, no flag, no test code', () => {
    const row = publicStoreRow(storedRow());
    expectNoToken(row);
    expect(row).not.toHaveProperty('meta_capi_token_set');
    expect(row).not.toHaveProperty('meta_test_event_code');
    expect(row).toMatchObject({ id: 's1', meta_pixel_id: '123456789012345' });
  });
});

describe('PUT /stores/my/store: meta_capi_token', () => {
  it('stores the token encrypted and never returns it', async () => {
    const { service, prisma, crypto } = build(
      storedRow({ meta_capi_token: null }),
    );
    const res = await service.update('u1', { meta_capi_token: ` ${TOKEN} ` });

    expect(crypto.encrypt).toHaveBeenCalledWith(TOKEN);
    expect(updateData(prisma).data).toEqual({ meta_capi_token: ENCRYPTED });
    // The plaintext is never written.
    expect(JSON.stringify(updateData(prisma).data)).not.toContain(TOKEN);
    expect(res).toMatchObject({ meta_capi_token_set: true });
    expectNoToken(res);
  });

  it('an empty string or null clears the stored token', async () => {
    for (const value of ['', '   ', null]) {
      const { service, prisma, crypto } = build();
      const res = await service.update('u1', { meta_capi_token: value });
      expect(updateData(prisma).data).toEqual({ meta_capi_token: null });
      expect(crypto.encrypt).not.toHaveBeenCalled();
      expect(res).toMatchObject({ meta_capi_token_set: false });
      expectNoToken(res);
    }
  });

  it('an update that does not mention the token keeps it', async () => {
    const { service, prisma, crypto } = build();
    const res = await service.update('u1', { meta_pixel_id: '99999' });
    expect('meta_capi_token' in updateData(prisma).data).toBe(false);
    expect(crypto.encrypt).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      meta_capi_token_set: true,
      meta_pixel_id: '99999',
    });
    expectNoToken(res);
  });

  it('stores / clears the test event code', async () => {
    const { service, prisma } = build();
    await service.update('u1', { meta_test_event_code: ' TEST777 ' });
    await service.update('u1', { meta_test_event_code: '' });
    await service.update('u1', { meta_test_event_code: null });
    expect(updateData(prisma, 0).data).toEqual({
      meta_test_event_code: 'TEST777',
    });
    expect(updateData(prisma, 1).data).toEqual({ meta_test_event_code: null });
    expect(updateData(prisma, 2).data).toEqual({ meta_test_event_code: null });
  });

  it('refuses to store a token when no encryption service is wired', async () => {
    const { prisma } = build();
    const bare = new StoresService(
      prisma as unknown as PrismaService,
      {
        revalidateStoreBySlug: jest.fn(() => Promise.resolve()),
      } as unknown as RevalidationService,
      {} as OrdersService,
      {
        isEnabled: jest.fn(() => Promise.resolve(false)),
      } as unknown as StoreAppsService,
      {} as MarketsService,
      { invalidate: jest.fn() } as unknown as MarketsContextService,
      {} as RedirectsService,
    );
    await expect(bare.update('u1', { meta_capi_token: TOKEN })).rejects.toThrow(
      'CryptoService is not wired',
    );
    expect(prisma.store.update).not.toHaveBeenCalled();
  });
});

describe('store payloads never carry the token', () => {
  it('GET /stores/my/store (owner): flag only', async () => {
    const { service, prisma } = build();
    const res = await service.findByCreator('u1');
    expect(res).toMatchObject({
      meta_capi_token_set: true,
      meta_test_event_code: 'TEST12345',
    });
    expectNoToken(res);
    // The owner read opts the column in only to derive the flag.
    expect(prisma.store.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ omit: { meta_capi_token: false } }),
    );
  });

  it('admin read / update by creator id: flag only', async () => {
    const { service } = build();
    const read = await service.findByCreatorId('c1');
    expect(read).toMatchObject({ meta_capi_token_set: true });
    expectNoToken(read);

    const updated = await service.adminUpdateByCreatorId('c1', {
      name: 'Namez',
    });
    expect(updated).toMatchObject({ meta_capi_token_set: true });
    expectNoToken(updated);
  });

  it('theme updates (owner): flag only', async () => {
    const { service } = build();
    const theme = await service.updateTheme('u1', { theme_config: {} });
    expect(theme).toMatchObject({ meta_capi_token_set: true });
    expectNoToken(theme);
    const selection = await service.updateThemeSelection('u1', {
      theme_key: 'bold',
    });
    expect(selection).toMatchObject({ meta_capi_token_set: true });
    expectNoToken(selection);
  });

  it('GET /stores/:slug (public): no token, flag or test code', async () => {
    const { service } = build();
    const res = await service.findBySlug('namez');
    expectNoToken(res);
    expect(res).not.toHaveProperty('meta_capi_token_set');
    expect(res).not.toHaveProperty('meta_test_event_code');
    expect(JSON.stringify(res)).not.toContain('TEST12345');
  });

  it('provider store list / detail: no token, flag or test code', async () => {
    const row = storedRow();
    const prisma = {
      provider: { findUnique: jest.fn(() => Promise.resolve({ id: 'pr1' })) },
      store: {
        findMany: jest.fn(() => Promise.resolve([{ ...row }])),
        count: jest.fn(() => Promise.resolve(1)),
        findUnique: jest.fn(() => Promise.resolve({ ...row })),
      },
      customProduct: {
        count: jest.fn(() => Promise.resolve(2)),
        findFirst: jest.fn(() => Promise.resolve({ id: 'cp1' })),
        findMany: jest.fn(() => Promise.resolve([])),
      },
      storeDomain: { findMany: jest.fn(() => Promise.resolve([])) },
      market: { findFirst: jest.fn(() => Promise.resolve(null)) },
    };
    const providers = new (ProvidersService as unknown as new (
      ...args: unknown[]
    ) => ProvidersService)(
      prisma,
      { isEnabled: jest.fn(() => Promise.resolve(false)) },
      {},
      {},
      {},
    );
    for (const res of [
      await providers.findStoresUsingProvider('u1', 1, 20),
      await providers.findStoreForProvider('u1', 's1'),
    ]) {
      expectNoToken(res);
      const json = JSON.stringify(res);
      expect(json).not.toContain('meta_capi_token_set');
      expect(json).not.toContain('meta_test_event_code');
      expect(json).not.toContain('TEST12345');
    }
  });
});

describe('UpdateStoreDto: Conversions API fields', () => {
  async function errorsFor(body: Record<string, unknown>): Promise<string[]> {
    const errors = await validate(plainToInstance(UpdateStoreDto, body), {
      skipMissingProperties: true,
    });
    return errors.map((e) => e.property);
  }

  it('accepts a Meta access token (trimmed), an empty string or null', async () => {
    for (const ok of [
      TOKEN,
      `  ${TOKEN}  `,
      'EAA' + 'x'.repeat(597),
      '1234567890|AbC-dEf_123',
      '',
      null,
    ]) {
      expect(await errorsFor({ meta_capi_token: ok })).toEqual([]);
    }
    for (const bad of [
      'EAA' + 'x'.repeat(598),
      'has space inside',
      'semi;colon',
      'quote"',
      '<script>',
      12345,
      true,
      {},
    ]) {
      expect(await errorsFor({ meta_capi_token: bad })).toEqual([
        'meta_capi_token',
      ]);
    }
  });

  it('the token is trimmed before it reaches the service', () => {
    const dto = plainToInstance(UpdateStoreDto, {
      meta_capi_token: `  ${TOKEN}\n`,
    });
    expect(dto.meta_capi_token).toBe(TOKEN);
  });

  it('accepts a test event code of up to 40 letters, digits, "_" or "-"', async () => {
    for (const ok of [
      'TEST12345',
      'test_1-2',
      'A'.repeat(40),
      ' TEST1 ',
      '',
      null,
    ]) {
      expect(await errorsFor({ meta_test_event_code: ok })).toEqual([]);
    }
    for (const bad of [
      'A'.repeat(41),
      'TEST 123',
      'TEST!',
      'tést',
      123,
      true,
    ]) {
      expect(await errorsFor({ meta_test_event_code: bad })).toEqual([
        'meta_test_event_code',
      ]);
    }
  });
});
