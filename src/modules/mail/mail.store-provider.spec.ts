import type { ConfigService } from '@nestjs/config';
import { EmailLogStatus } from '@prisma/client';
import { MailService } from './mail.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import type { NotificationTemplatesService } from '../notification-templates/notification-templates.service';
import type {
  StoreMailProvider,
  StoreMailProviderResult,
} from './store-mail-provider';

// The store mail provider seam (Zoho Mail app): a provider that sends wins;
// one that fails or throws leaves the store SMTP → platform fallback exactly
// as before; null (not applicable) changes nothing.

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

function build(opts: { storeSmtp?: boolean; storeSmtpFails?: boolean } = {}) {
  const service = new MailService(
    { get: () => undefined } as unknown as ConfigService,
    {} as PrismaService,
    {} as CryptoService,
    {} as NotificationTemplatesService,
  );
  const internals = service as unknown as Internals;
  jest.spyOn(internals, 'resolveStoreConfig').mockResolvedValue(
    opts.storeSmtp
      ? {
          host: 'smtp.store',
          port: 587,
          secure: false,
          from: 'shop@store.se',
        }
      : null,
  );
  jest.spyOn(internals, 'resolveConfig').mockResolvedValue({
    host: 'smtp.platform',
    port: 587,
    secure: false,
    from: 'no-reply@platform.se',
    platformName: 'Platform',
  });
  const sendMail = jest.fn((msg: { from: string }) =>
    opts.storeSmtpFails && msg.from === 'shop@store.se'
      ? Promise.reject(new Error('store smtp down'))
      : Promise.resolve({}),
  );
  jest
    .spyOn(
      service as unknown as Record<string, () => unknown>,
      'transporterFor',
    )
    .mockReturnValue({ sendMail });
  const logDelivery = jest
    .spyOn(internals, 'logDelivery')
    .mockResolvedValue(undefined);
  return { service, sendMail, logDelivery };
}

function provider(
  impl: () => Promise<StoreMailProviderResult | null>,
): StoreMailProvider & { sendForStore: jest.Mock } {
  return { via: 'zoho', sendForStore: jest.fn(impl) };
}

const msg = {
  to: 'anna@example.com',
  subject: 'Order',
  html: '<p>h</p>',
  text: 't',
  storeId: 's1',
  brandFooter: { storeName: 'Shop', customerEmail: 'anna@example.com' },
};

describe('MailService store mail providers', () => {
  it('a provider that sends wins: no SMTP, log via zoho', async () => {
    const { service, sendMail, logDelivery } = build({ storeSmtp: true });
    const p = provider(() =>
      Promise.resolve({ sent: true, host: 'mail.zoho.eu' }),
    );
    service.registerStoreMailProvider(p);
    expect(await service.send(msg)).toEqual({ sent: true });
    expect(sendMail).not.toHaveBeenCalled();
    expect(p.sendForStore).toHaveBeenCalledWith('s1', {
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      attachments: undefined,
    });
    expect(logDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ storeId: 's1' }),
      { status: EmailLogStatus.SENT, via: 'zoho', host: 'mail.zoho.eu' },
    );
  });

  it('provider failure falls back to the store SMTP', async () => {
    const { service, sendMail, logDelivery } = build({ storeSmtp: true });
    service.registerStoreMailProvider(
      provider(() =>
        Promise.resolve({ sent: false, host: 'mail.zoho.eu', error: 'boom' }),
      ),
    );
    expect(await service.send(msg)).toEqual({ sent: true });
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(sendMail.mock.calls[0][0]).toMatchObject({ from: 'shop@store.se' });
    expect(logDelivery.mock.calls.map((c) => c[1])).toEqual([
      {
        status: EmailLogStatus.FAILED,
        via: 'zoho',
        host: 'mail.zoho.eu',
        error: 'boom',
      },
      { status: EmailLogStatus.SENT, via: 'store', host: 'smtp.store' },
    ]);
  });

  it('provider throwing + no store SMTP falls back to the platform sender with footer', async () => {
    const { service, sendMail } = build();
    service.registerStoreMailProvider(
      provider(() => Promise.reject(new Error('crash'))),
    );
    expect(await service.send(msg)).toEqual({ sent: true });
    const sent = sendMail.mock.calls[0][0] as { from: string; html: string };
    expect(sent.from).toBe('no-reply@platform.se');
    expect(sent.html).toContain('Platform');
  });

  it('provider + store SMTP failing reaches the platform sender', async () => {
    const { service, sendMail } = build({
      storeSmtp: true,
      storeSmtpFails: true,
    });
    service.registerStoreMailProvider(
      provider(() =>
        Promise.resolve({ sent: false, host: 'mail.zoho.eu', error: 'x' }),
      ),
    );
    expect(await service.send(msg)).toEqual({ sent: true });
    expect(
      sendMail.mock.calls.map((c) => (c[0] as { from: string }).from),
    ).toEqual(['shop@store.se', 'no-reply@platform.se']);
  });

  it('null (not applicable) and no storeId leave the old path untouched', async () => {
    const { service, sendMail, logDelivery } = build();
    const p = provider(() => Promise.resolve(null));
    service.registerStoreMailProvider(p);
    await service.send(msg);
    await service.send({ ...msg, storeId: undefined });
    expect(p.sendForStore).toHaveBeenCalledTimes(1);
    expect(sendMail).toHaveBeenCalledTimes(2);
    expect(
      logDelivery.mock.calls.every(
        (c) => (c[1] as { via: string }).via === 'platform',
      ),
    ).toBe(true);
  });
});
