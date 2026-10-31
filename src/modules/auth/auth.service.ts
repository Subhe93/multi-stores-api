import {
  Injectable,
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

/** Bcrypt cost of every password hash written by the auth flows. */
const PASSWORD_BCRYPT_COST = 12;

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
  ) {}

  private emailExists(): ConflictException {
    return new ConflictException({
      code: 'AUTH_EMAIL_EXISTS',
      message: 'Email already registered',
    });
  }

  /** Storefront context of a request, used only when the store is live. */
  private async activeStore(
    storeSlug?: string,
    hostname?: string,
  ): Promise<StoreLinkContext | null> {
    const store = await this.links.resolveStore(storeSlug, hostname);
    return store?.isActive ? store : null;
  }

  /**
   * Account lookup by email. New rows are stored normalised (see
   * normalizeEmail), so the unique index answers the common case; rows
   * created before normalisation may still be mixed case, hence the
   * case-insensitive fallback. Existing rows are lower-cased by a separate
   * one-off data migration, after which the fallback can go.
   */
  private async findUserByEmail(email: string) {
    const normalized = normalizeEmail(email);
    const exact = await this.prisma.user.findUnique({
      where: { email: normalized },
    });
    if (exact) return exact;
    return this.prisma.user.findFirst({
      where: { email: { equals: normalized, mode: 'insensitive' } },
    });
  }

  async register(dto: RegisterDto) {
    const email = normalizeEmail(dto.email);
    const existing = await this.findUserByEmail(email);
    if (existing) throw this.emailExists();

    if (dto.role === UserRole.ADMIN) {
      throw new ForbiddenException({
        code: 'AUTH_CANNOT_REGISTER_ADMIN',
        message: 'Cannot register as admin',
      });
    }

    const password_hash = await bcrypt.hash(dto.password, PASSWORD_BCRYPT_COST);

    const user = await this.prisma.user.create({
      data: {
        email,
        password_hash,
        role: dto.role,
        status: 'ACTIVE',
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        created_at: true,
      },
    });

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

    const tokens = await this.generateTokens(user.id, user.email, user.role);

    // Welcome email, best-effort and never blocking signup. A storefront
    // signup (store_slug) gets the store's branding, domain and language; the
    // user chose the password, so the email never contains one.
    void this.sendRegisterWelcome(user.email, dto).catch(() => undefined);

    return { user, ...tokens };
  }

  private async sendRegisterWelcome(email: string, dto: RegisterDto) {
    const store = await this.activeStore(dto.store_slug, dto.hostname);
    const locale = dto.locale ?? store?.primaryLocale ?? undefined;
    const loginUrl = this.links.storefrontLink(
      store?.base,
      '/auth/login',
      undefined,
      locale,
    );
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
   */
  async guestRegister(dto: GuestRegisterDto) {
    const email = normalizeEmail(dto.email);
    if (await this.findUserByEmail(email)) throw this.emailExists();

    const password = generateAccountPassword();
    const password_hash = await bcrypt.hash(password, PASSWORD_BCRYPT_COST);
    let user: Pick<User, 'id' | 'email' | 'role' | 'status' | 'created_at'>;
    try {
      user = await this.prisma.user.create({
        data: {
          email,
          password_hash,
          role: UserRole.CUSTOMER,
          status: 'ACTIVE',
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
          created_at: true,
        },
      });
    } catch (err) {
      // A concurrent signup with the same email won the unique index.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw this.emailExists();
      }
      throw err;
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role);

    // Credentials email off the response path; never fails the signup.
    const created = user;
    void (async () => {
      const store = await this.activeStore(dto.store_slug, dto.hostname);
      await this.credentials.send({
        user: created,
        name: dto.first_name,
        password,
        store: store ? { id: store.id, name: store.name } : null,
        storeBase: store?.base ?? null,
        locale: dto.locale ?? store?.primaryLocale ?? null,
      });
    })().catch(() => undefined);

    return { user, ...tokens };
  }

  /**
   * Exchanges a magic login link for a session. Unknown, expired, used and
   * inactive-account links all get the same 401.
   */
  async magicLogin(token: string) {
    const user = await this.magicLinks.consume(token);
    if (!user) {
      throw new UnauthorizedException({
        code: 'MAGIC_LINK_INVALID',
        message: 'This login link is invalid or has expired',
      });
    }
    const tokens = await this.generateTokens(user.id, user.email, user.role);
    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
      },
      ...tokens,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.findUserByEmail(dto.email);

    if (!user) {
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_CREDENTIALS',
        message: 'Invalid credentials',
      });
    }

    const passwordValid = await bcrypt.compare(
      dto.password,
      user.password_hash,
    );
    if (!passwordValid) {
      throw new UnauthorizedException({
        code: 'AUTH_INVALID_CREDENTIALS',
        message: 'Invalid credentials',
      });
    }

    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException({
        code: 'AUTH_ACCOUNT_NOT_ACTIVE',
        message: 'Account is not active',
      });
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role);

    return {
      user: {
        id: user.id,
        email: user.email,
        role: user.role,
        status: user.status,
      },
      ...tokens,
    };
  }

  async refreshToken(refreshToken: string) {
    try {
      const payload = this.jwtService.verify<{ sub: string }>(refreshToken, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET'),
      });

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

      return this.generateTokens(user.id, user.email, user.role);
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

  async forgotPassword(email: string, storeSlug?: string, hostname?: string) {
    const user = await this.findUserByEmail(email);

    // Never reveal whether the email exists — always return the same message.
    if (!user) {
      return { message: 'If the email exists, a reset link will be sent' };
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
    const store = await this.links.resolveStore(storeSlug, hostname);
    const resetUrl = this.links.storefrontLink(
      store?.base,
      '/auth/reset-password',
      `token=${encodeURIComponent(resetToken)}`,
      'en',
    );
    const mailLocale = store?.primaryLocale ?? undefined;
    await this.mail.sendPasswordReset(user.email, resetUrl, mailLocale);

    return { message: 'If the email exists, a reset link will be sent' };
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

      await this.prisma.user.update({
        where: { id: payload.sub },
        data: { password_hash },
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
    await this.prisma.user.update({
      where: { id: userId },
      data: { password_hash },
    });
    // Mailed magic links must not outlive the old password.
    await this.magicLinks.invalidateForUser(userId);

    return { message: 'Password changed successfully' };
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
        created_at: true,
        provider: true,
        // Never ship the Kustom shared secret, not even as ciphertext.
        creator: { omit: { kustom_shared_secret: true } },
        customer: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }

  private async generateTokens(userId: string, email: string, role: UserRole) {
    const payload = { sub: userId, email, role };

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
