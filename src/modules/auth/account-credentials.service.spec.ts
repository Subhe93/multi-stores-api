import { UserRole } from '@prisma/client';
import { AccountCredentialsService } from './account-credentials.service';
import type { MagicLinkService } from './magic-link.service';
import type { AccountLinksService } from './account-links.service';
import type { MailService } from '../mail/mail.service';
import type { PrismaService } from '../../prisma/prisma.service';

// "Store without customer accounts" (`checkout_settings.no_customer_accounts`):
// the credentials email of an AUTOMATIC account creation (guest checkout,
// Kustom callback) is skipped and no magic link is minted. Explicit operator
// sends (no `checkoutStoreId`) and every other store are sent as before.

const input = {
  user: { id: 'u1', email: 'anna@example.com', role: UserRole.CUSTOMER },
  name: 'Anna',
  password: 'Kx7mP2qRw9Tn4bVz',
  store: { id: 's1', name: 'Prima' },
  storeBase: 'https://prima.example.se',
  locale: 'sv',
};

function build(
  opts: {
    settings?: unknown;
    lookupFails?: boolean;
    withoutPrisma?: boolean;
  } = {},
) {
  const magicLinks = { issue: jest.fn(() => Promise.resolve('raw-token')) };
  const links = {
    accountLinks: jest.fn(() => ({
      magicUrl: 'https://prima.example.se/magic',
      loginUrl: 'https://prima.example.se/login',
    })),
  };
  const mail = { sendAccountCreated: jest.fn(() => Promise.resolve()) };
  const prisma = {
    store: {
      findUnique: jest.fn(() =>
        opts.lookupFails
          ? Promise.reject(new Error('db down'))
          : Promise.resolve({ checkout_settings: opts.settings ?? null }),
      ),
    },
  };
  const service = new AccountCredentialsService(
    magicLinks as unknown as MagicLinkService,
    links as unknown as AccountLinksService,
    mail as unknown as MailService,
    ...(opts.withoutPrisma ? [] : [prisma as unknown as PrismaService]),
  );
  return { service, magicLinks, mail, prisma };
}

describe('AccountCredentialsService.send (store without customer accounts)', () => {
  it('automatic creation in a no-accounts store: no token, no email', async () => {
    const { service, magicLinks, mail, prisma } = build({
      settings: { no_customer_accounts: true },
    });
    await service.send({ ...input, checkoutStoreId: 's1' });
    expect(prisma.store.findUnique).toHaveBeenCalledWith({
      where: { id: 's1' },
      select: { checkout_settings: true },
    });
    expect(magicLinks.issue).not.toHaveBeenCalled();
    expect(mail.sendAccountCreated).not.toHaveBeenCalled();
  });

  it('the store context does not matter (a not-yet-live store passes store: null)', async () => {
    const { service, magicLinks, mail } = build({
      settings: { no_customer_accounts: true },
    });
    await service.send({
      ...input,
      store: null,
      storeBase: null,
      checkoutStoreId: 's1',
    });
    expect(magicLinks.issue).not.toHaveBeenCalled();
    expect(mail.sendAccountCreated).not.toHaveBeenCalled();
  });

  it.each([
    ['no settings', null],
    ['other settings', { phone_required: true }],
    ['flag false', { no_customer_accounts: false }],
    ['flag not a boolean', { no_customer_accounts: 'true' }],
  ])('automatic creation, %s: sent as before', async (_label, settings) => {
    const { service, magicLinks, mail } = build({ settings });
    await service.send({ ...input, checkoutStoreId: 's1' });
    expect(magicLinks.issue).toHaveBeenCalledTimes(1);
    expect(mail.sendAccountCreated).toHaveBeenCalledTimes(1);
    expect(mail.sendAccountCreated).toHaveBeenCalledWith(
      'anna@example.com',
      {
        name: 'Anna',
        email: 'anna@example.com',
        password: 'Kx7mP2qRw9Tn4bVz',
        magicUrl: 'https://prima.example.se/magic',
        loginUrl: 'https://prima.example.se/login',
        expiresHours: expect.any(Number) as unknown,
      },
      'sv',
      { storeId: 's1', storeName: 'Prima' },
    );
  });

  it('an explicit operator send (no checkoutStoreId) is never suppressed', async () => {
    const { service, magicLinks, mail, prisma } = build({
      settings: { no_customer_accounts: true },
    });
    await service.send(input);
    await service.send({ ...input, checkoutStoreId: null });
    expect(prisma.store.findUnique).not.toHaveBeenCalled();
    expect(magicLinks.issue).toHaveBeenCalledTimes(2);
    expect(mail.sendAccountCreated).toHaveBeenCalledTimes(2);
  });

  it('a failed flag lookup falls back to sending', async () => {
    const { service, magicLinks, mail } = build({ lookupFails: true });
    await service.send({ ...input, checkoutStoreId: 's1' });
    expect(magicLinks.issue).toHaveBeenCalledTimes(1);
    expect(mail.sendAccountCreated).toHaveBeenCalledTimes(1);
  });

  it('without a prisma handle (three-argument construction) it sends', async () => {
    const { service, magicLinks, mail } = build({ withoutPrisma: true });
    await service.send({ ...input, checkoutStoreId: 's1' });
    expect(magicLinks.issue).toHaveBeenCalledTimes(1);
    expect(mail.sendAccountCreated).toHaveBeenCalledTimes(1);
  });
});
