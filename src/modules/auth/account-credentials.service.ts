import { Injectable, Logger } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { MailService } from '../mail/mail.service';
import { MagicLinkService, MAGIC_LINK_TTL_HOURS } from './magic-link.service';
import { AccountLinksService } from './account-links.service';

export interface AccountCredentialsInput {
  user: { id: string; email: string; role: UserRole };
  name?: string | null;
  /** Plain password: only ever held in memory to build this one email. */
  password: string;
  /** Store the account was created through (branding + magic token scope). */
  store?: { id: string; name: string } | null;
  /** Public origin of that store; null/absent = platform links. */
  storeBase?: string | null;
  locale?: string | null;
}

/**
 * Mails the credentials of an account the platform created on the user's
 * behalf: the password plus a single-use magic login link. Best-effort and
 * never throws. Neither the password nor the raw token is ever logged.
 */
@Injectable()
export class AccountCredentialsService {
  private readonly logger = new Logger(AccountCredentialsService.name);

  constructor(
    private readonly magicLinks: MagicLinkService,
    private readonly links: AccountLinksService,
    private readonly mail: MailService,
  ) {}

  async send(input: AccountCredentialsInput): Promise<void> {
    try {
      const raw = await this.magicLinks.issue(input.user.id, {
        storeId: input.store?.id ?? null,
        ttlHours: MAGIC_LINK_TTL_HOURS,
      });
      const { magicUrl, loginUrl } = this.links.accountLinks(raw, {
        role: input.user.role,
        storeBase: input.storeBase,
        locale: input.locale,
      });
      await this.mail.sendAccountCreated(
        input.user.email,
        {
          name: input.name?.trim() || '',
          email: input.user.email,
          password: input.password,
          magicUrl,
          loginUrl,
          expiresHours: MAGIC_LINK_TTL_HOURS,
        },
        input.locale ?? null,
        input.store
          ? { storeId: input.store.id, storeName: input.store.name }
          : null,
      );
    } catch (err) {
      // Only the user id and the error class: the message of a failed mail
      // or DB call could echo the template variables.
      this.logger.warn(
        `Account credentials email for user ${input.user.id} failed (${
          err instanceof Error ? err.name : 'unknown error'
        })`,
      );
    }
  }
}
