import { UserRole } from '@prisma/client';
import { UsersService, publicPlatformConfig } from './users.service';
import type { PrismaService } from '../../prisma/prisma.service';

// GET /admin/platform-config is readable by providers and creators: it must
// never return credentials (or their ciphertexts) or admin-only settings.

const row = {
  id: 'pc1',
  commission_type: 'percentage',
  commission_value: 15,
  default_currency: 'EUR',
  default_locale: 'en',
  supported_locales: ['en'],
  platform_name: 'ShopsDoor',
  stripe_secret_key: 'enc:sk',
  stripe_publishable_key: 'pk_live',
  stripe_webhook_secret: 'enc:whsec',
  stripe_connect_webhook_secret: 'enc:whsec_connect',
  kustom_partner_id: 'partner-1',
  smtp_host: 'smtp.example.com',
  smtp_port: 587,
  smtp_secure: false,
  smtp_user: 'u',
  smtp_pass: 'enc:p',
  mail_from: 'no-reply@example.com',
  backup_enabled: true,
  backup_frequency: 'DAILY',
  backup_time: '03:00',
  backup_weekday: 0,
  backup_retention: 14,
  backup_include_uploads: true,
  backup_last_run_at: null,
};

const SECRETS = [
  'stripe_secret_key',
  'stripe_publishable_key',
  'stripe_webhook_secret',
  'stripe_connect_webhook_secret',
  'smtp_host',
  'smtp_port',
  'smtp_secure',
  'smtp_user',
  'smtp_pass',
  'mail_from',
];

describe('publicPlatformConfig', () => {
  it.each([UserRole.PROVIDER, UserRole.CREATOR])(
    '%s: no secrets, no Kustom partner id, no backup settings',
    (role) => {
      const out = publicPlatformConfig(row, role) as Record<string, unknown>;
      for (const k of SECRETS) expect(out).not.toHaveProperty(k);
      expect(out).not.toHaveProperty('kustom_partner_id');
      expect(Object.keys(out).some((k) => k.startsWith('backup_'))).toBe(false);
      expect(out).toMatchObject({
        commission_value: 15,
        default_currency: 'EUR',
        supported_locales: ['en'],
      });
    },
  );

  it('admin: still never the secrets, but the admin settings', () => {
    const out = publicPlatformConfig(row, UserRole.ADMIN) as Record<
      string,
      unknown
    >;
    for (const k of SECRETS) expect(out).not.toHaveProperty(k);
    expect(out).toMatchObject({
      kustom_partner_id: 'partner-1',
      backup_enabled: true,
    });
  });

  it('getPlatformConfig strips by the caller role', async () => {
    const prisma = {
      platformConfig: { findFirst: jest.fn(() => Promise.resolve(row)) },
    };
    const service = Object.create(UsersService.prototype) as UsersService;
    (service as unknown as { prisma: unknown }).prisma =
      prisma as unknown as PrismaService;
    const out = (await service.getPlatformConfig(UserRole.CREATOR)) as Record<
      string,
      unknown
    >;
    expect(out).not.toHaveProperty('stripe_connect_webhook_secret');
    expect(out).not.toHaveProperty('backup_time');
  });
});
