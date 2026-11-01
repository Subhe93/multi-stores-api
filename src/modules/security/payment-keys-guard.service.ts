import { Injectable } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import type { RequestUser } from '../../common/decorators/current-user.decorator';
import { ReauthService, type ReauthInput } from './reauth.service';
import { SecurityAuditService } from './security-audit.service';
import type { RequestMeta } from './request-meta';
import type { SecurityAlertKind } from '../mail/templates';

type Scope = 'platform' | 'kustom' | 'stripe_connect';

const SCOPES: Record<
  Scope,
  {
    action:
      | 'payment_keys.platform.updated'
      | 'payment_keys.kustom.updated'
      | 'payment_keys.stripe_connect.disconnected';
    alert: SecurityAlertKind;
    require2fa: boolean;
  }
> = {
  platform: {
    action: 'payment_keys.platform.updated',
    alert: 'platform_keys_changed',
    require2fa: true,
  },
  kustom: {
    action: 'payment_keys.kustom.updated',
    alert: 'kustom_keys_changed',
    require2fa: false,
  },
  stripe_connect: {
    action: 'payment_keys.stripe_connect.disconnected',
    alert: 'stripe_disconnected',
    require2fa: false,
  },
};

/**
 * Wraps every payment-credential change: re-authenticate first, run the
 * change, then write the audit row and send the alert emails. Field VALUES
 * never leave this class — only names, with "(cleared)" for removals.
 *
 * Future credential types (e.g. the owner's restricted Stripe key) should go
 * through here too.
 */
@Injectable()
export class PaymentKeysGuardService {
  constructor(
    private readonly reauth: ReauthService,
    private readonly audit: SecurityAuditService,
  ) {}

  /**
   * `changed` maps credential field names to their new value (undefined =
   * untouched). Without any touched field the change runs with no re-auth.
   */
  async run<T>(opts: {
    scope: Scope;
    user: RequestUser;
    input: ReauthInput;
    changed: Record<string, string | undefined>;
    meta: RequestMeta;
    /** Always re-authenticate, even with no field (e.g. disconnect). */
    always?: boolean;
    apply: () => Promise<T>;
  }): Promise<T> {
    const scope = SCOPES[opts.scope];
    const fields = Object.entries(opts.changed)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => (v!.trim() === '' ? `${k} (cleared)` : k));
    if (!fields.length && !opts.always) return opts.apply();

    await this.reauth.verify(opts.user.id, opts.input, {
      purpose: scope.action,
      require2fa: scope.require2fa,
      meta: opts.meta,
    });
    const result = await opts.apply();

    const targetType =
      opts.scope === 'platform'
        ? 'platform'
        : opts.user.role === UserRole.PROVIDER
          ? 'provider'
          : 'creator';
    await this.audit.record({
      actor: { id: opts.user.id, email: opts.user.email, role: opts.user.role },
      action: scope.action,
      targetType,
      targetId: opts.scope === 'platform' ? null : opts.user.id,
      targetLabel:
        opts.scope === 'platform' ? 'Stripe (platform)' : opts.user.email,
      fields,
      meta: opts.meta,
    });
    const recipients =
      opts.scope === 'platform'
        ? await this.audit.adminEmails()
        : [opts.user.email];
    this.audit.alert(
      recipients,
      scope.alert,
      { actorEmail: opts.user.email, fields, meta: opts.meta },
      opts.scope === 'platform'
        ? await this.audit.platformLocale()
        : await this.audit.localeFor(opts.user.id),
    );
    return result;
  }
}
