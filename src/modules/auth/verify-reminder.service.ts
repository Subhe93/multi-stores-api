import {
  Injectable,
  Logger,
  Optional,
  type OnModuleInit,
} from '@nestjs/common';
import { LoginTokenPurpose, UserRole, UserStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import { RetentionService } from '../retention/retention.service';
import type {
  RetentionRunOptions,
  RetentionTaskResult,
} from '../retention/retention.types';
import { EMAIL_VERIFY_TTL_HOURS, MagicLinkService } from './magic-link.service';
import { AccountLinksService } from './account-links.service';
import { VERIFICATION_GRACE_DAYS } from '../../common/guards/verified-account.guard';

/** Retention task key (`POST /admin/retention/run?task=`). */
export const VERIFY_REMINDER_TASK = 'auth.verify-reminder';
/** EmailLog / template event of the reminder. */
export const VERIFY_REMINDER_EVENT = 'verify_reminder';
/** Days after sign-up a still-PENDING account is reminded (SPEC §5). */
export const VERIFY_REMINDER_DAYS = [3, 6] as const;

const DAY_MS = 24 * 60 * 60 * 1000;
/** A reminder logged within this window counts as "already sent today". */
const DEDUPE_MS = 2 * DAY_MS;

/**
 * Daily "verify your email" reminders for PENDING staff accounts, sent on
 * day 3 and day 6 after sign-up. Runs as a task of the hourly
 * RetentionService (the same mechanism as the production daily digest); the
 * EmailLog is the dedupe, so an hourly tick never sends twice.
 */
@Injectable()
export class VerifyReminderService implements OnModuleInit {
  private readonly logger = new Logger(VerifyReminderService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    private readonly magicLinks: MagicLinkService,
    private readonly links: AccountLinksService,
    @Optional() private readonly retention?: RetentionService,
  ) {}

  onModuleInit(): void {
    this.retention?.registerTask({
      key: VERIFY_REMINDER_TASK,
      run: (now, opts) => this.run(now, opts),
    });
  }

  /** Accounts whose sign-up age (whole days) is a reminder day. */
  static dueDay(createdAt: Date, now: Date): number | null {
    const age = Math.floor((now.getTime() - createdAt.getTime()) / DAY_MS);
    return (VERIFY_REMINDER_DAYS as readonly number[]).includes(age)
      ? age
      : null;
  }

  async run(
    now: Date,
    opts: Partial<RetentionRunOptions> = {},
  ): Promise<RetentionTaskResult> {
    const result: RetentionTaskResult = {
      purged: 0,
      skipped: 0,
      errors: 0,
      details: { sent: 0, notDue: 0, alreadySent: 0 },
    };
    const bump = (key: string) => {
      result.details![key] = (result.details![key] ?? 0) + 1;
    };
    // Candidates: PENDING staff, unverified, inside the reminder window.
    const oldest = new Date(now.getTime() - (VERIFICATION_GRACE_DAYS + 1) * DAY_MS);
    const users = await this.prisma.user.findMany({
      where: {
        role: { not: UserRole.CUSTOMER },
        status: UserStatus.PENDING,
        email_verified_at: null,
        created_at: { gte: oldest, lte: new Date(now.getTime() - 3 * DAY_MS) },
      },
      select: { id: true, email: true, role: true, created_at: true },
      take: opts.limit ?? 500,
    });
    for (const user of users) {
      if (opts.deadline !== undefined && Date.now() >= opts.deadline) break;
      const day = VerifyReminderService.dueDay(user.created_at, now);
      if (day === null) {
        bump('notDue');
        result.skipped++;
        continue;
      }
      try {
        const already = await this.prisma.emailLog.findFirst({
          where: {
            event: VERIFY_REMINDER_EVENT,
            recipient: user.email,
            created_at: { gte: new Date(now.getTime() - DEDUPE_MS) },
          },
          select: { id: true },
        });
        if (already) {
          bump('alreadySent');
          result.skipped++;
          continue;
        }
        if (opts.dryRun) {
          bump('sent');
          result.purged++;
          continue;
        }
        await this.sendReminder(user, VERIFICATION_GRACE_DAYS - day);
        bump('sent');
        result.purged++;
      } catch (err) {
        result.errors++;
        this.logger.warn(
          `Verify reminder failed for ${user.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return result;
  }

  private async sendReminder(
    user: { id: string; email: string; role: UserRole },
    daysLeft: number,
  ): Promise<void> {
    const raw = await this.magicLinks.issue(user.id, {
      purpose: LoginTokenPurpose.EMAIL_VERIFY,
      ttlHours: EMAIL_VERIFY_TTL_HOURS,
    });
    const url = `${this.links.dashboardUrl()}/auth/verify#token=${encodeURIComponent(raw)}`;
    const name =
      user.role === UserRole.CREATOR
        ? (
            await this.prisma.creator.findUnique({
              where: { user_id: user.id },
              select: { display_name: true },
            })
          )?.display_name
        : (
            await this.prisma.provider.findUnique({
              where: { user_id: user.id },
              select: { contact_name: true },
            })
          )?.contact_name;
    await this.mail.sendOnboarding(
      VERIFY_REMINDER_EVENT,
      user.email,
      { name: name ?? '', verify_url: url, days_left: String(daysLeft) },
      undefined,
      { sensitive: [raw] },
    );
  }
}
