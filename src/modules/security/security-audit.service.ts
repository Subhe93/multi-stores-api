import { Injectable, Logger } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MailService } from '../mail/mail.service';
import type { SecurityAlertKind } from '../mail/templates';
import type { RequestMeta } from './request-meta';

export const SECURITY_ACTIONS = [
  'payment_keys.platform.updated',
  'payment_keys.kustom.updated',
  'payment_keys.stripe_connect.disconnected',
  'two_factor.enabled',
  'two_factor.disabled',
  'two_factor.recovery_regenerated',
  'two_factor.recovery_used',
  'two_factor.login_failed',
  'two_factor.locked',
  'two_factor.reset_by_admin',
  'reauth.failed',
  'reauth.granted',
  'user.created_staff',
  'user.email_changed_by_admin',
  'user.password_reset_by_admin',
  'user.status_changed',
  'user.deleted_by_admin',
] as const;
export type SecurityAction = (typeof SECURITY_ACTIONS)[number];

export interface SecurityActor {
  id: string | null;
  email: string;
  role?: UserRole | null;
}

export interface SecurityEventInput {
  actor: SecurityActor;
  action: SecurityAction;
  targetType?: 'platform' | 'creator' | 'provider' | 'user';
  targetId?: string | null;
  targetLabel?: string | null;
  /** Field NAMES only — never pass a secret value here. */
  fields?: string[];
  meta?: RequestMeta;
}

/**
 * Append-only security trail plus email alerts. Recording never throws: a
 * failing audit write must not break the change the user asked for, but it
 * is logged loudly so it gets noticed.
 */
@Injectable()
export class SecurityAuditService {
  private readonly logger = new Logger(SecurityAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
  ) {}

  async record(input: SecurityEventInput): Promise<void> {
    try {
      await this.prisma.securityEvent.create({
        data: {
          user_id: input.actor.id,
          actor_email: input.actor.email,
          actor_role: input.actor.role ?? null,
          action: input.action,
          target_type: input.targetType ?? null,
          target_id: input.targetId ?? null,
          target_label: input.targetLabel ?? null,
          fields: input.fields ?? [],
          ip: input.meta?.ip ?? null,
          user_agent: input.meta?.userAgent ?? null,
        },
      });
    } catch (err) {
      this.logger.error(
        `Failed to record security event ${input.action}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /** Fire-and-forget alert emails; never awaited by request handlers. */
  alert(
    recipients: string[],
    kind: SecurityAlertKind,
    input: { actorEmail: string; fields?: string[]; meta?: RequestMeta },
    locale?: string,
  ): void {
    const unique = [...new Set(recipients.filter(Boolean))];
    for (const to of unique) {
      void this.mail
        .sendSecurityAlert(
          to,
          {
            kind,
            actorEmail: input.actorEmail,
            fields: input.fields,
            at: new Date(),
            ip: input.meta?.ip,
            userAgent: input.meta?.userAgent,
          },
          locale,
        )
        .catch((err: unknown) =>
          this.logger.warn(
            `Security alert ${kind} to ${to} failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
    }
  }

  /** Emails of every ACTIVE admin (recipients of platform-level alerts). */
  async adminEmails(): Promise<string[]> {
    const rows = await this.prisma.user.findMany({
      where: { role: UserRole.ADMIN, status: 'ACTIVE' },
      select: { email: true },
    });
    return rows.map((r) => r.email);
  }

  /**
   * Language of an owner-facing alert: a creator's store primary locale,
   * otherwise the platform default.
   */
  async localeFor(userId: string): Promise<string> {
    try {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
        select: {
          store: {
            select: { language_config: { select: { primary_locale: true } } },
          },
        },
      });
      const locale = creator?.store?.language_config?.primary_locale;
      if (locale) return locale;
    } catch {
      // Fall through to the platform default.
    }
    return this.platformLocale();
  }

  /** Platform default locale, used for admin-facing alerts. */
  async platformLocale(): Promise<string> {
    const cfg = await this.prisma.platformConfig.findFirst({
      select: { default_locale: true },
    });
    return cfg?.default_locale || 'en';
  }

  async list(query: { page?: string; limit?: string; action?: string }) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 25));
    const action = (SECURITY_ACTIONS as readonly string[]).includes(
      query.action ?? '',
    )
      ? query.action
      : undefined;
    const where = action ? { action } : {};
    const [rows, total] = await Promise.all([
      this.prisma.securityEvent.findMany({
        where,
        orderBy: { created_at: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          created_at: true,
          action: true,
          actor_email: true,
          actor_role: true,
          target_type: true,
          target_id: true,
          target_label: true,
          fields: true,
          ip: true,
          user_agent: true,
        },
      }),
      this.prisma.securityEvent.count({ where }),
    ]);
    return { items: rows, total, page, limit };
  }
}
