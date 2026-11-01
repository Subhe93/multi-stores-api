import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MagicLinkService } from '../auth/magic-link.service';
import type { AccountCredentialsService } from '../auth/account-credentials.service';
import type { AccountLinksService } from '../auth/account-links.service';

function build() {
  const created = {
    id: 'u-new',
    email: 'staff@example.com',
    role: UserRole.CREATOR,
    status: 'ACTIVE',
    avatar_url: null,
    created_at: new Date(),
  };
  const prisma = {
    user: {
      findUnique: jest.fn((args: { where: { id?: string } }) =>
        Promise.resolve(
          args.where.id ? { ...created, id: args.where.id } : null,
        ),
      ),
      findFirst: jest.fn((_args: unknown) => Promise.resolve(null)),
      create: jest.fn((_args: unknown) => Promise.resolve(created)),
      update: jest.fn(() => Promise.resolve({})),
    },
    store: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(where.id === 's1' ? { id: 's1', slug: 'namez' } : null),
      ),
    },
    creator: { create: jest.fn(() => Promise.resolve({})) },
    customer: { create: jest.fn(() => Promise.resolve({})) },
    provider: { create: jest.fn(() => Promise.resolve({})) },
    session: { deleteMany: jest.fn(() => Promise.resolve({ count: 0 })) },
  };
  const magicLinks = { invalidateForUser: jest.fn(() => Promise.resolve()) };
  const credentials = { send: jest.fn((_input: unknown) => Promise.resolve()) };
  const links = {
    resolveStore: jest.fn(() =>
      Promise.resolve({
        id: 's1',
        slug: 'namez',
        name: 'Namez',
        primaryLocale: 'sv',
        isActive: true,
        base: 'https://namez.se',
      }),
    ),
  };
  const service = new UsersService(
    prisma as unknown as PrismaService,
    magicLinks as unknown as MagicLinkService,
    credentials as unknown as AccountCredentialsService,
    links as unknown as AccountLinksService,
  );
  return { service, prisma, magicLinks, credentials };
}

describe('UsersService.create send_credentials', () => {
  const dto = {
    email: 'staff@example.com',
    password: 'Typed-by-admin-1',
    role: UserRole.CREATOR,
    display_name: 'Studio',
  };

  it('mails the typed password with a role-appropriate magic link when asked', async () => {
    const { service, credentials } = build();
    const res = await service.create({
      ...dto,
      send_credentials: true,
      locale: 'ar',
    });
    expect(credentials.send).toHaveBeenCalledWith({
      user: { id: 'u-new', email: 'staff@example.com', role: 'CREATOR' },
      name: 'Studio',
      password: 'Typed-by-admin-1',
      store: null,
      storeBase: null,
      locale: 'ar',
    });
    // The response never echoes the password.
    expect(JSON.stringify(res)).not.toContain('Typed-by-admin-1');
  });

  it("defaults the email language to 'en'", async () => {
    const { service, credentials } = build();
    await service.create({ ...dto, send_credentials: true });
    expect(
      (credentials.send.mock.calls[0] as unknown as [{ locale: string }])[0]
        .locale,
    ).toBe('en');
  });

  it('sends nothing when send_credentials is false or absent', async () => {
    const { service, credentials } = build();
    await service.create({ ...dto, send_credentials: false });
    await service.create(dto);
    expect(credentials.send).not.toHaveBeenCalled();
  });
});

describe('UsersService.resetPassword', () => {
  it('invalidates outstanding magic links', async () => {
    const { service, magicLinks } = build();
    await service.resetPassword('u1', 'new-password-1');
    expect(magicLinks.invalidateForUser).toHaveBeenCalledWith('u1');
  });
});

describe('UsersService.create customers per store', () => {
  const dto = {
    email: ' Anna@Example.com ',
    password: 'Typed-by-admin-1',
    role: UserRole.CUSTOMER,
    first_name: 'Anna',
  };

  it('a CUSTOMER without store_id is 400 STORE_REQUIRED', async () => {
    const { service, prisma } = build();
    const err = await service.create(dto).catch((e: unknown) => e);
    expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
      code: 'STORE_REQUIRED',
    });
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('an unknown store_id is 400 STORE_NOT_FOUND', async () => {
    const { service } = build();
    const err = await service
      .create({ ...dto, store_id: 'nope' })
      .catch((e: unknown) => e);
    expect((err as { getResponse(): unknown }).getResponse()).toMatchObject({
      code: 'STORE_NOT_FOUND',
    });
  });

  it('creates the customer in that store (normalised email, conflict checked in the store only) and mails store links', async () => {
    const { service, prisma, credentials } = build();
    await service.create({ ...dto, store_id: 's1', send_credentials: true });
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ store_id: 's1' }) as unknown,
      }),
    );
    const data = (
      prisma.user.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data).toMatchObject({
      email: 'anna@example.com',
      role: 'CUSTOMER',
      store_id: 's1',
    });
    for (let i = 0; i < 20 && credentials.send.mock.calls.length === 0; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(credentials.send.mock.calls[0][0]).toMatchObject({
      store: { id: 's1', name: 'Namez' },
      storeBase: 'https://namez.se',
    });
  });

  it('staff are created without a store; the conflict check is among staff', async () => {
    const { service, prisma } = build();
    await service.create({
      email: 'staff@example.com',
      password: 'Typed-by-admin-1',
      role: UserRole.CREATOR,
      store_id: 's1',
    });
    const data = (
      prisma.user.create.mock.calls[0] as unknown as [
        { data: Record<string, unknown> },
      ]
    )[0].data;
    expect(data.store_id).toBeNull();
    expect(prisma.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ store_id: null }) as unknown,
      }),
    );
  });
});
