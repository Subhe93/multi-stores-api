import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MagicLinkService } from '../auth/magic-link.service';
import type { AccountCredentialsService } from '../auth/account-credentials.service';

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
      create: jest.fn(() => Promise.resolve(created)),
      update: jest.fn(() => Promise.resolve({})),
    },
    creator: { create: jest.fn(() => Promise.resolve({})) },
    customer: { create: jest.fn(() => Promise.resolve({})) },
    provider: { create: jest.fn(() => Promise.resolve({})) },
    session: { deleteMany: jest.fn(() => Promise.resolve({ count: 0 })) },
  };
  const magicLinks = { invalidateForUser: jest.fn(() => Promise.resolve()) };
  const credentials = { send: jest.fn(() => Promise.resolve()) };
  const service = new UsersService(
    prisma as unknown as PrismaService,
    magicLinks as unknown as MagicLinkService,
    credentials as unknown as AccountCredentialsService,
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
