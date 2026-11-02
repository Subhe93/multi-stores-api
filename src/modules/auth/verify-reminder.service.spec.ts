import { UserRole } from '@prisma/client';
import { VerifyReminderService } from './verify-reminder.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { MailService } from '../mail/mail.service';
import type { MagicLinkService } from './magic-link.service';
import type { AccountLinksService } from './account-links.service';
import type { RetentionService } from '../retention/retention.service';

// SPEC §5: the daily verify_reminder (day 3 and day 6 while PENDING), run
// as a retention task; the EmailLog is the dedupe.

const NOW = new Date('2026-11-10T09:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3600_000);

function build(users: Array<{ id: string; created_at: Date }>, logged: string[] = []) {
  const prisma = {
    user: {
      findMany: jest.fn(() =>
        Promise.resolve(
          users.map((u) => ({
            ...u,
            email: `${u.id}@x.se`,
            role: UserRole.CREATOR,
          })),
        ),
      ),
    },
    emailLog: {
      findFirst: jest.fn(({ where }: { where: { recipient: string } }) =>
        Promise.resolve(logged.includes(where.recipient) ? { id: 'l' } : null),
      ),
    },
    creator: {
      findUnique: jest.fn(() => Promise.resolve({ display_name: 'Anna' })),
    },
    provider: { findUnique: jest.fn() },
  };
  const mail = { sendOnboarding: jest.fn(() => Promise.resolve({ sent: true })) };
  const magicLinks = { issue: jest.fn(() => Promise.resolve('RawTok_0123456789abcdefghij')) };
  const links = { dashboardUrl: () => 'https://dash.x' };
  const retention = { registerTask: jest.fn() };
  const service = new VerifyReminderService(
    prisma as unknown as PrismaService,
    mail as unknown as MailService,
    magicLinks as unknown as MagicLinkService,
    links as unknown as AccountLinksService,
    retention as unknown as RetentionService,
  );
  return { service, prisma, mail, magicLinks, retention };
}

describe('VerifyReminderService', () => {
  it('registers itself as the auth.verify-reminder retention task', () => {
    const { service, retention } = build([]);
    service.onModuleInit();
    expect(retention.registerTask).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'auth.verify-reminder' }),
    );
  });

  it('is due on day 3 and day 6 only', () => {
    expect(VerifyReminderService.dueDay(daysAgo(3), NOW)).toBe(3);
    expect(VerifyReminderService.dueDay(daysAgo(3.5), NOW)).toBe(3);
    expect(VerifyReminderService.dueDay(daysAgo(6), NOW)).toBe(6);
    expect(VerifyReminderService.dueDay(daysAgo(4), NOW)).toBeNull();
    expect(VerifyReminderService.dueDay(daysAgo(7), NOW)).toBeNull();
  });

  it('sends with days_left, skips not-due and already-reminded accounts', async () => {
    const { service, mail, magicLinks } = build(
      [
        { id: 'day3', created_at: daysAgo(3) },
        { id: 'day4', created_at: daysAgo(4) },
        { id: 'day6', created_at: daysAgo(6) },
        { id: 'done', created_at: daysAgo(6) },
      ],
      ['done@x.se'],
    );
    const res = await service.run(NOW, { dryRun: false, limit: 100 });
    expect(res).toMatchObject({
      purged: 2,
      skipped: 2,
      errors: 0,
      details: { sent: 2, notDue: 1, alreadySent: 1 },
    });
    expect(magicLinks.issue).toHaveBeenCalledWith('day3', {
      purpose: 'EMAIL_VERIFY',
      ttlHours: 24,
    });
    expect(mail.sendOnboarding).toHaveBeenCalledWith(
      'verify_reminder',
      'day3@x.se',
      expect.objectContaining({
        name: 'Anna',
        days_left: '4',
        verify_url: expect.stringContaining('https://dash.x/auth/verify#token='),
      }),
      undefined,
      { sensitive: ['RawTok_0123456789abcdefghij'] },
    );
    expect(mail.sendOnboarding).toHaveBeenCalledWith(
      'verify_reminder',
      'day6@x.se',
      expect.objectContaining({ days_left: '1' }),
      undefined,
      expect.anything(),
    );
  });

  it('dry run counts without sending', async () => {
    const { service, mail } = build([{ id: 'day3', created_at: daysAgo(3) }]);
    const res = await service.run(NOW, { dryRun: true, limit: 100 });
    expect(res.purged).toBe(1);
    expect(mail.sendOnboarding).not.toHaveBeenCalled();
  });
});
