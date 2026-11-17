import { Injectable, Logger, Optional } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { MailService } from '../mail/mail.service';
import { MagicLinkService, MAGIC_LINK_TTL_HOURS } from './magic-link.service';
import { AccountLinksService } from './account-links.service';
import { PrismaService } from '../../prisma/prisma.service';
import { readStoredCheckoutSettings } from '../stores/checkout-settings';

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
  /**
   * Store whose checkout created the account automatically (guest checkout,
   * Kustom callback). When that store runs without customer accounts
   * (`checkout_settings.no_customer_accounts`) nothing is sent. Explicit
   * operator sends leave it unset and are never suppressed.
   */
  checkoutStoreId?: string | null;
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
    @Optional() private readonly prisma?: PrismaService,
  ) {}

  async send(input: AccountCredentialsInput): Promise<void> {
    // Before the magic link is minted: a suppressed email leaves no token.
    if (await this.suppressedByStore(input.checkoutStoreId)) return;
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

  /**
   * True when the store of an automatic account creation runs without
   * customer accounts. A failed lookup means "not suppressed" (the email is
   * sent as before).
   */
  private async suppressedByStore(
    storeId: string | null | undefined,
  ): Promise<boolean> {
    if (!storeId || !this.prisma) return false;
    try {
      const row = await this.prisma.store.findUnique({
        where: { id: storeId },
        select: { checkout_settings: true },
      });
      return (
        readStoredCheckoutSettings(row?.checkout_settings)
          .no_customer_accounts === true
      );
    } catch {
      return false;
    }
  }
}
