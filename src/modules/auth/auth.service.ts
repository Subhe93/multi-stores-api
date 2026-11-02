import {
  Injectable,
  BadRequestException,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService, type JwtSignOptions } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto, LoginDto, GuestRegisterDto } from './dto';
import { Prisma, UserRole, type User } from '@prisma/client';
import { MailService } from '../mail/mail.service';
import { normalizeEmail } from '../../common/email/email.util';
import { generateAccountPassword } from '../../common/security/account-password';
import { MagicLinkService } from './magic-link.service';
import {
  AccountLinksService,
  type StoreLinkContext,
} from './account-links.service';
import { AccountCredentialsService } from './account-credentials.service';
import { TwoFactorService } from '../security/two-factor.service';
import type { RequestMeta } from '../security/request-meta';

/** Bcrypt cost of every password hash written by the auth flows. */
const PASSWORD_BCRYPT_COST = 12;

// Lifetime of the single-use link that signs a freshly registered staff
// account in on the dashboard (the browser follows it right away).
const REGISTER_HANDOFF_TTL_HOURS = 0.25;

/** Claims of the access and refresh tokens. `store_id` is null for staff. */
export interface AuthTokenPayload {
  sub: string;
  email: string;
  role: UserRole;
  store_id: string | null;
}

/** The fields of a user the tokens are built from. */
type TokenSubject = Pick<User, 'id' | 'email' | 'role' | 'store_id'> &
  Partial<Pick<User, 'tokens_valid_after'>>;

/** Same body for every failed login, so no case reveals an account. */
const INVALID_CREDENTIALS = {
  code: 'AUTH_INVALID_CREDENTIALS',
  message: 'Invalid credentials',
} as const;

const FORGOT_PASSWORD_MESSAGE =
  'If the email exists, a reset link will be sent';

/**
 * Bcrypt hash compared against when no account matched a login, so a miss
 * costs the same time as a wrong password (no timing-based enumeration).
 * Built lazily once (same cost as real hashes, so the timing matches).
 */
let dummyHash: Promise<string> | null = null;
function dummyPasswordHash(): Promise<string> {
  dummyHash ??= bcrypt.hash('no-account-dummy-password', PASSWORD_BCRYPT_COST);
  return dummyHash;
}

/**
 * Whether a token's store claim fits the account. Staff: always (their
 * store_id is null). Customer: the claim must exist and name the account's
 * store; tokens issued before accounts were per store lack the claim and are
 * rejected, which forces a fresh, store-scoped login.
 */
export function tokenStoreMatches(
  payload: { store_id?: string | null },
  user: { role: UserRole; store_id: string | null },
): boolean {
  if (user.role !== UserRole.CUSTOMER) return true;
  return (
    typeof payload.store_id === 'string' &&
    user.store_id !== null &&
    payload.store_id === user.store_id
  );
}

/**
 * Revocation cutoff (User.tokens_valid_after): a token whose `iat` (whole
 * seconds) is at or before the cutoff second is dead. Blocking a user,
 * resetting or changing the password moves the cutoff to "now", which kills
 * every access and refresh token issued before it in one write.
 */
export function tokenIssuedAfterCutoff(
  payload: { iat?: number },
  user: { tokens_valid_after?: Date | null },
): boolean {
  const cutoff = user.tokens_valid_after;
  if (!cutoff) return true;
  if (typeof payload.iat !== 'number') return false;
  return payload.iat > Math.floor(cutoff.getTime() / 1000);
}

/**
 * `iat` for a token minted now: the current second, but never at or before
 * the user's cutoff second, so a token issued right after a revocation (same
 * second, e.g. change-password returning a fresh pair) is not born dead.
 */
export function issuedAtFor(
  user: { tokens_valid_after?: Date | null },
  nowMs = Date.now(),
): number {
  const now = Math.floor(nowMs / 1000);
  const cutoff = user.tokens_valid_after;
  if (!cutoff) return now;
  return Math.max(now, Math.floor(cutoff.getTime() / 1000) + 1);
}

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mail: MailService,
    private readonly magicLinks: MagicLinkService,
    private readonly links: AccountLinksService,
    private readonly credentials: AccountCredentialsService,
    private readonly twoFactor: TwoFactorService,
  ) {}

  private emailExists(): ConflictException {
    return new ConflictException({
      code: 'AUTH_EMAIL_EXISTS',
      message: 'Email already registered',
    });
  }

  private storeRequired(): BadRequestException {
    return new BadRequestException({
      code: 'STORE_REQUIRED',
      message: 'Customer accounts need a store (store_slug or hostname)',
    });
  }

  /**
   * Account lookups by email. A CUSTOMER belongs to exactly one store and is
   * found only within it; staff (ADMIN/CREATOR/PROVIDER) have store_id NULL
   * and are found only without a store. New rows are stored normalised (see
   * normalizeEmail), so the unique index answers the common case; rows
   * created before normalisation may still be mixed case, hence the
   * case-insensitive fallback.
   */
  private async findStoreCustomer(storeId: string, email: string) {
    const normalized = normalizeEmail(email);
    const exact = await this.prisma.user.findUnique({
      where: { store_id_email: { store_id: storeId, email: normalized } },
    });
    if (exact) return exact.role === UserRole.CUSTOMER ? exact : null;
    return this.prisma.user.findFirst({
      where: {
        store_id: storeId,
        role: UserRole.CUSTOMER,
        email: { equals: normalized, mode: 'insensitive' },
      },
    });
  }

  private async findStaff(email: string) {
    const normalized = normalizeEmail(email);
    const where = { store_id: null, role: { not: UserRole.CUSTOMER } };
    return (
      (await this.prisma.user.findFirst({
        where: { ...where, email: normalized },
      })) ??
      this.prisma.user.findFirst({
        where: {
          ...where,
          email: { equals: normalized, mode: 'insensitive' },
        },
      })
    );
  }

  /**
   * Whether a staff registration would collide with the platform-wide
   * unique index on email (`User_staff_email_key`, rows with store_id NULL).
   */
  private async staffEmailTaken(email: string): Promise<boolean> {
    const row = await this.prisma.user.findFirst({
      where: {
        store_id: null,
        email: { equals: normalizeEmail(email), mode: 'insensitive' },
      },
      select: { id: true },
    });
    return row !== null;
  }

  private isUniqueViolation(err: unknown): boolean {
    return (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2002'
    );
  }

  /**
   * Self-registration. A CUSTOMER registers in one store (store_slug /
   * hostname required, 400 STORE_REQUIRED otherwise) and the email only has
   * to be free within that store. CREATOR / PROVIDER accounts stay
   * platform-wide; a store context sent with them is ignored.
   */
  async register(dto: RegisterDto) {
    if (dto.role === UserRole.ADMIN) {
      throw new ForbiddenException({
        code: 'AUTH_CANNOT_REGISTER_ADMIN',
        message: 'Cannot register as admin',
      });
    }

    const email = normalizeEmail(dto.email);
    const isCustomer = dto.role === UserRole.CUSTOMER;
    const store = isCustomer
      ? await this.links.resolveRequestStore(dto.store_slug, dto.hostname)
      : null;
    if (isCustomer && !store) throw this.storeRequired();

    const taken = store
      ? (await this.findStoreCustomer(store.id, email)) !== null
      : await this.staffEmailTaken(email);
    if (taken) throw this.emailExists();

    const password_hash = await bcrypt.hash(dto.password, PASSWORD_BCRYPT_COST);

    let user: Pick<
      User,
      'id' | 'email' | 'role' | 'status' | 'store_id' | 'created_at'
    >;
    try {
      user = await this.prisma.user.create({
        data: {
          email,
          password_hash,
          role: dto.role,
          status: 'ACTIVE',
          store_id: store?.id ?? null,
        },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          store_id: true,
          created_at: true,
        },
      });
    } catch (err) {
      // A concurrent signup with the same email won the unique index.
      if (this.isUniqueViolation(err)) throw this.emailExists();
      throw err;
    }

    // Create role-specific profile record
    if (dto.role === UserRole.CUSTOMER) {
      await this.prisma.customer.create({
        data: {
          user_id: user.id,
          first_name: dto.first_name || '',
          last_name: dto.last_name || '',
          ...(dto.phone ? { phone: dto.phone } : {}),
        },
      });
    } else if (dto.role === UserRole.PROVIDER) {
      await this.prisma.provider.create({
        data: {
          user_id: user.id,
          company_name: dto.first_name || 'My Company',
          country: 'US',
        },
      });
    } else if (dto.role === UserRole.CREATOR) {
      await this.prisma.creator.create({
        data: { user_id: user.id, display_name: dto.first_name || 'Creator' },
      });
    }

    const tokens = await this.generateTokens(user);

    // Staff sign-ups continue on the dashboard, a separate origin that never
    // sees this response's tokens. A short-lived single-use magic link signs
    // the new account in there, so nobody has to log in twice.
    let dashboard_login_url: string | undefined;
    if (!isCustomer) {
      const raw = await this.magicLinks.issue(user.id, {
        ttlHours: REGISTER_HANDOFF_TTL_HOURS,
      });
      dashboard_login_url = this.links.accountLinks(raw, {
        role: user.role,
      }).magicUrl;
    }

    // Welcome email, best-effort and never blocking signup. A storefront
    // signup gets the store's branding, domain and language (only while the
    // store is live); the user chose the password, so the email never
    // contains one.
    const live = store?.isActive ? store : null;
    void this.sendRegisterWelcome(user.email, dto, live).catch(() => undefined);

    return {
      user,
      ...tokens,
      ...(dashboard_login_url ? { dashboard_login_url } : {}),
    };
  }

  private async sendRegisterWelcome(
    email: string,
    dto: RegisterDto,
    store: StoreLinkContext | null,
  ) {
    const locale = dto.locale ?? store?.primaryLocale ?? undefined;
    // Staff sign in on the dashboard; customers on their store.
    const loginUrl =
      dto.role === UserRole.CUSTOMER
        ? this.links.storefrontLink(
            store?.base,
            '/auth/login',
            undefined,
            locale,
          )
        : `${this.links.dashboardUrl()}/auth/login`;
    await this.mail.sendWelcome(
      email,
      { name: dto.first_name, loginUrl },
      locale,
      store ? { storeId: store.id, storeName: store.name } : undefined,
    );
  }

  /**
   * Storefront guest checkout: creates a CUSTOMER with a server-generated
   * password and mails it with a single-use magic login link. Returns the
   * same body as register (the shopper is logged in right away). The plain
   * password lives only in this call's memory and the outgoing email.
   * The account belongs to the store of the request (400 STORE_REQUIRED
   * without one); the email only has to be free within that store.
   */
  async guestRegister(dto: GuestRegisterDto) {
    const store = await this.links.resolveRequestStore(
      dto.store_slug,
      dto.hostname,
    );
    if (!store) throw this.storeRequired();
    const email = normalizeEmail(dto.email);
    if (await this.findStoreCustomer(store.id, email)) throw this.emailExists();

    const password = generateAccountPassword();
    const password_hash = await bcrypt.hash(password, PASSWORD_BCRYPT_COST);
    let user: Pick<
      User,
      'id' | 'email' | 'role' | 'status' | 'store_id' | 'created_at'
    >;
    try {
      user = await this.prisma.user.create({
        data: {
          email,
          password_hash,
          role: UserRole.CUSTOMER,
          status: 'ACTIVE',
          store_id: store.id,
          customer: {
            create: {
              first_name: dto.first_name?.trim() || '',
              last_name: dto.last_name?.trim() || '',
              ...(dto.phone ? { phone: dto.phone } : {}),
            },
          },
        },
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          store_id: true,
          created_at: true,
        },
      });
    } catch (err) {
      // A concurrent signup with the same email won the unique index.
      if (this.isUniqueViolation(err)) throw this.emailExists();
      throw err;
    }

    const tokens = await this.generateTokens(user);

    // Credentials email off the response path; never fails the signup.
    // Branding and store-domain links only while the store is live.
    const live = store.isActive ? store : null;
    void this.credentials
      .send({
        user,
        name: dto.first_name,
        password,
        store: live ? { id: live.id, name: live.name } : null,
        storeBase: live?.base ?? null,
        locale: dto.locale ?? live?.primaryLocale ?? null,
      })
      .catch(() => undefined);

    return { user, ...tokens };
  }

  /**
   * Exchanges a magic login link for a session. Unknown, expired, used and
   * inactive-account links all get the same 401.
   *
   * With a store context (storefront: store_slug / hostname) the link must
   * belong to a CUSTOMER of that store. A mismatch (another store's customer,
   * a staff account, an unknown store) gets the same 401 and is checked
   * BEFORE the atomic consume, so the link stays usable where it belongs.
   * Without a context (dashboard) any account's link is accepted.
   */
  async magicLogin(
    token: string,
    context: { store_slug?: string; hostname?: string } = {},
  ) {
    const invalid = () =>
      new UnauthorizedException({
        code: 'MAGIC_LINK_INVALID',
        message: 'This login link is invalid or has expired',
      });

    if (context.store_slug?.trim() || context.hostname?.trim()) {
      const store = await this.links
        .resolveRequestStore(context.store_slug, context.hostname)
        .catch(() => null);
      const owner = await this.magicLinks.peek(token);
      if (
        !store ||
        !owner ||
        owner.role !== UserRole.CUSTOMER ||
        owner.storeId !== store.id
      ) {
        throw invalid();
      }
    }

    const user = await this.magicLinks.consume(token);
    if (!user) throw invalid();
    // A mailed link proves the inbox, not the second factor.
    if (await this.twoFactorEnabled(user.id)) {
      return this.twoFactor.issueChallenge(user.id);
    }
    const tokens = await this.generateTokens(user);
    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        store_id: user.store_id,
      },
      ...tokens,
    };
  }

  /**
   * With a store context (store_slug / hostname) only that store's CUSTOMER
   * can log in; without one only staff (the dashboard and the platform
   * login send no store). Every failing case answers the same 401.
   */
  async login(dto: LoginDto) {
    const store = await this.links.resolveRequestStore(
      dto.store_slug,
      dto.hostname,
    );
    const user = store
      ? await this.findStoreCustomer(store.id, dto.email)
      : await this.findStaff(dto.email);

    // A miss still runs one bcrypt compare, so the response time does not
    // reveal whether the email exists.
    const passwordValid = await bcrypt.compare(
      dto.password,
      user?.password_hash ?? (await dummyPasswordHash()),
    );
    if (!user || !passwordValid) {
      throw new UnauthorizedException(INVALID_CREDENTIALS);
    }

    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'AUTH_ACCOUNT_NOT_ACTIVE',
        message: 'Account is not active',
      });
    }

    // Password is right; with 2FA on, the tokens wait for the code
    // (POST /auth/2fa/verify-login).
    if (user.totp_enabled_at && user.totp_secret) {
      return this.twoFactor.issueChallenge(user.id);
    }

    const tokens = await this.generateTokens(user);

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        store_id: user.store_id,
      },
      ...tokens,
    };
  }

  async refreshToken(refreshToken: string) {
    try {
      const payload = this.jwtService.verify<Partial<AuthTokenPayload>>(
        refreshToken,
        { secret: this.configService.get<string>('JWT_REFRESH_SECRET') },
      );
      // Purpose tokens (2FA challenge, password reset) carry `type`; they
      // must never be exchanged for a session, even if the secrets match.
      if ((payload as { type?: unknown }).type !== undefined || !payload.sub) {
        throw new UnauthorizedException();
      }

      // logout() records the surrendered token as an expired session row. That
      // list was never consulted here, so a token stolen before logout stayed
      // usable until it expired naturally.
      const revoked = await this.prisma.session.findUnique({
        where: { token: refreshToken },
      });
      if (revoked && revoked.expires_at <= new Date()) {
        throw new UnauthorizedException();
      }

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException();
      }
      // Same rule as JwtStrategy: a customer token minted before accounts
      // were per store (no store_id claim), or for another store, is dead.
      if (!tokenStoreMatches(payload, user)) {
        throw new UnauthorizedException();
      }
      // Issued before the last block / password reset / password change.
      if (!tokenIssuedAfterCutoff(payload as { iat?: number }, user)) {
        throw new UnauthorizedException();
      }

      return this.generateTokens(user);
    } catch {
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_REFRESH_TOKEN',
        message: 'Invalid refresh token',
      });
    }
  }

  async logout(userId: string, refreshToken?: string) {
    // Drop the user's session rows (this also invalidates any outstanding
    // password-reset links, which share this table).
    await this.prisma.session.deleteMany({
      where: { user_id: userId },
    });

    // Record the surrendered refresh token as revoked. An already-expired
    // expires_at is the marker refreshToken() checks for.
    if (refreshToken) {
      await this.prisma.session.create({
        data: {
          user_id: userId,
          token: refreshToken,
          expires_at: new Date(0),
        },
      });
    }

    return { message: 'Logged out successfully' };
  }

  /**
   * With a store context: the customer of that store; without one: staff
   * only. The answer is the same whether or not an account matched.
   */
  async forgotPassword(email: string, storeSlug?: string, hostname?: string) {
    const store = await this.links.resolveRequestStore(storeSlug, hostname);
    const user = store
      ? await this.findStoreCustomer(store.id, email)
      : await this.findStaff(email);

    // Never reveal whether the email exists — always return the same message.
    if (!user) {
      return { message: FORGOT_PASSWORD_MESSAGE };
    }

    // Create a reset token (valid for 1 hour).
    const resetToken = await this.jwtService.signAsync(
      { sub: user.id, type: 'password_reset' },
      {
        secret: this.configService.get<string>('JWT_SECRET')!,
        expiresIn: '1h',
      },
    );

    // Persist the token in sessions so it can be used exactly once.
    await this.prisma.session.create({
      data: {
        user_id: user.id,
        token: resetToken,
        expires_at: new Date(Date.now() + 60 * 60 * 1000), // 1 hour
      },
    });

    // Email the reset link (best-effort — never blocks or reveals existence).
    // When the request came from a store, use that store's primary locale so
    // the email body matches the storefront language.
    // The link points back at the store's own domain (market host, custom
    // domain or {slug}.{platform-host}) so the customer stays in the same
    // storefront; otherwise at the platform storefront ([locale] tree).
    const resetUrl = this.links.storefrontLink(
      store?.base,
      '/auth/reset-password',
      `token=${encodeURIComponent(resetToken)}`,
      'en',
    );
    const mailLocale = store?.primaryLocale ?? undefined;
    // Off the response path: awaiting SMTP made a hit measurably slower than
    // a miss (timing-based account enumeration), and a mail failure surfaced
    // as a 500 only for existing accounts.
    void this.mail
      .sendPasswordReset(user.email, resetUrl, mailLocale)
      .catch(() => undefined);

    return { message: FORGOT_PASSWORD_MESSAGE };
  }

  async resetPassword(token: string, newPassword: string) {
    try {
      const payload = this.jwtService.verify<{ sub: string; type?: string }>(
        token,
        {
          secret: this.configService.get<string>('JWT_SECRET')!,
        },
      );

      if (payload.type !== 'password_reset') {
        throw new UnauthorizedException({
          code: 'AUTH_INVALID_RESET_TOKEN',
          message: 'Invalid reset token',
        });
      }

      // Ensure the token still exists in sessions (i.e. wasn't already used).
      const session = await this.prisma.session.findUnique({
        where: { token },
      });

      if (!session || session.expires_at < new Date()) {
        throw new UnauthorizedException({
          code: 'AUTH_RESET_TOKEN_EXPIRED',
          message: 'Reset token expired or already used',
        });
      }

      const password_hash = await bcrypt.hash(
        newPassword,
        PASSWORD_BCRYPT_COST,
      );

      // The cutoff kills every access/refresh token issued so far.
      await this.prisma.user.update({
        where: { id: payload.sub },
        data: { password_hash, tokens_valid_after: new Date() },
      });
      // Mailed magic links must not outlive the old password.
      await this.magicLinks.invalidateForUser(payload.sub);

      // Revoke ALL of the user's sessions: consumes this reset token, drops any
      // other outstanding reset links, and logs the user out everywhere.
      await this.prisma.session.deleteMany({ where: { user_id: payload.sub } });

      return { message: 'Password reset successfully' };
    } catch {
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_OR_EXPIRED_RESET_TOKEN',
        message: 'Invalid or expired reset token',
      });
    }
  }

  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user)
      throw new UnauthorizedException({
        code: 'AUTH_USER_NOT_FOUND',
        message: 'User not found',
      });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid)
      throw new UnauthorizedException({
        code: 'AUTH_CURRENT_PASSWORD_INCORRECT',
        message: 'Current password is incorrect',
      });

    const password_hash = await bcrypt.hash(newPassword, PASSWORD_BCRYPT_COST);
    // The cutoff signs out every other session (tokens issued so far); the
    // caller keeps going with the fresh pair returned below.
    const updated = await this.prisma.user.update({
      where: { id: userId },
      data: { password_hash, tokens_valid_after: new Date() },
    });
    // Mailed magic links must not outlive the old password.
    await this.magicLinks.invalidateForUser(userId);

    const tokens = await this.generateTokens(updated);
    return { message: 'Password changed successfully', ...tokens };
  }

  async getProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        avatar_url: true,
        store_id: true,
        store: { select: { id: true, slug: true, name: true } },
        created_at: true,
        provider: true,
        // Never ship the Kustom shared secret, not even as ciphertext.
        creator: { omit: { kustom_shared_secret: true } },
        customer: true,
        totp_enabled_at: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    const { totp_enabled_at, ...profile } = user;
    return { ...profile, two_factor_enabled: Boolean(totp_enabled_at) };
  }

  private async twoFactorEnabled(userId: string): Promise<boolean> {
    const row = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { totp_enabled_at: true, totp_secret: true },
    });
    return Boolean(row?.totp_enabled_at && row.totp_secret);
  }

  /** Second sign-in step: challenge + code → the normal login body. */
  async verifyTwoFactorLogin(
    challengeToken: string,
    code: string,
    meta?: RequestMeta,
  ) {
    const user = await this.twoFactor.verifyLogin(challengeToken, code, meta);
    const tokens = await this.generateTokens(user);
    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
        store_id: user.store_id,
      },
      ...tokens,
    };
  }

  /** Fresh token pair for an already-verified user (e.g. after enabling 2FA). */
  issueTokens(user: TokenSubject) {
    return this.generateTokens(user);
  }

  private async generateTokens(user: TokenSubject) {
    // Explicit iat: never at or before the revocation cutoff second.
    const payload: AuthTokenPayload & { iat: number } = {
      sub: user.id,
      email: user.email,
      role: user.role,
      store_id: user.store_id ?? null,
      iat: issuedAtFor(user),
    };

    const [access_token, refresh_token] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_SECRET')!,
        expiresIn: this.configService.get<string>(
          'JWT_EXPIRES_IN',
        ) as JwtSignOptions['expiresIn'],
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET')!,
        expiresIn: this.configService.get<string>(
          'JWT_REFRESH_EXPIRES_IN',
        ) as JwtSignOptions['expiresIn'],
      }),
    ]);

    return { access_token, refresh_token };
  }
}
