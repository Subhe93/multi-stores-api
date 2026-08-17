import {
  Injectable,
  ConflictException,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { RegisterDto, LoginDto } from './dto';
import { UserRole } from '@prisma/client';
import { MailService } from '../mail/mail.service';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
    private mail: MailService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException({ code: 'AUTH_EMAIL_EXISTS', message: 'Email already registered' });
    }

    if (dto.role === UserRole.ADMIN) {
      throw new ForbiddenException({ code: 'AUTH_CANNOT_REGISTER_ADMIN', message: 'Cannot register as admin' });
    }

    const password_hash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
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
        data: { user_id: user.id, company_name: dto.first_name || 'My Company', country: 'US' },
      });
    } else if (dto.role === UserRole.CREATOR) {
      await this.prisma.creator.create({
        data: { user_id: user.id, display_name: dto.first_name || 'Creator' },
      });
    }

    const tokens = await this.generateTokens(user.id, user.email, user.role);

    // Welcome email — best-effort, never blocks signup. Locale falls back to
    // the request's Accept-Language path via MailService → DB template lookup.
    const loginUrl =
      (this.configService.get<string>('STOREFRONT_URL') || 'http://localhost:3003') +
      '/auth/login';
    void this.mail.sendWelcome(user.email, {
      name: dto.first_name,
      loginUrl,
    });

    return { user, ...tokens };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials' });
    }

    const passwordValid = await bcrypt.compare(dto.password, user.password_hash);
    if (!passwordValid) {
      throw new UnauthorizedException({ code: 'AUTH_INVALID_CREDENTIALS', message: 'Invalid credentials' });
    }

    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException({ code: 'AUTH_ACCOUNT_NOT_ACTIVE', message: 'Account is not active' });
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
      const payload = this.jwtService.verify(refreshToken, {
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
      throw new UnauthorizedException({ code: 'AUTH_INVALID_REFRESH_TOKEN', message: 'Invalid refresh token' });
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

  async forgotPassword(email: string, storeSlug?: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // Never reveal whether the email exists — always return the same message.
    if (!user) {
      return { message: 'If the email exists, a reset link will be sent' };
    }

    // Create a reset token (valid for 1 hour).
    const resetToken = await this.jwtService.signAsync(
      { sub: user.id, type: 'password_reset' },
      {
        secret: this.configService.get<string>('JWT_SECRET')!,
        expiresIn: '1h' as any,
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
    const resetUrl = await this.buildResetUrl(resetToken, storeSlug);
    let mailLocale: string | undefined;
    if (storeSlug) {
      const store = await this.prisma.store.findUnique({
        where: { slug: storeSlug },
        select: { language_config: { select: { primary_locale: true } } },
      });
      mailLocale = store?.language_config?.primary_locale;
    }
    await this.mail.sendPasswordReset(user.email, resetUrl, mailLocale);

    return { message: 'If the email exists, a reset link will be sent' };
  }

  /**
   * Build the password-reset link. When the request came from a store
   * storefront (store_slug), the link points back at that store's own domain
   * (custom domain or {slug}.{platform-host}) so the customer stays in the same
   * storefront. Otherwise it points at the platform storefront ([locale] tree).
   * The store domain is derived server-side from the DB — never from raw client
   * input — so this can't be turned into an open redirect.
   */
  private async buildResetUrl(token: string, storeSlug?: string): Promise<string> {
    const platformBase =
      this.configService.get<string>('STOREFRONT_URL') ||
      'http://localhost:3003';
    const q = `token=${encodeURIComponent(token)}`;

    if (storeSlug) {
      const store = await this.prisma.store.findUnique({
        where: { slug: storeSlug },
        select: { slug: true, custom_domain: true, is_active: true },
      });
      if (store?.is_active) {
        if (store.custom_domain) {
          return `https://${store.custom_domain}/auth/reset-password?${q}`;
        }
        try {
          const url = new URL(platformBase);
          return `${url.protocol}//${store.slug}.${url.host}/auth/reset-password?${q}`;
        } catch {
          // Fall through to the platform link on a malformed base URL.
        }
      }
    }

    return `${platformBase}/en/auth/reset-password?${q}`;
  }

  async resetPassword(token: string, newPassword: string) {
    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET')!,
      });

      if (payload.type !== 'password_reset') {
        throw new UnauthorizedException({ code: 'AUTH_INVALID_RESET_TOKEN', message: 'Invalid reset token' });
      }

      // Ensure the token still exists in sessions (i.e. wasn't already used).
      const session = await this.prisma.session.findUnique({
        where: { token },
      });

      if (!session || session.expires_at < new Date()) {
        throw new UnauthorizedException({ code: 'AUTH_RESET_TOKEN_EXPIRED', message: 'Reset token expired or already used' });
      }

      const password_hash = await bcrypt.hash(newPassword, 12);

      await this.prisma.user.update({
        where: { id: payload.sub },
        data: { password_hash },
      });

      // Revoke ALL of the user's sessions: consumes this reset token, drops any
      // other outstanding reset links, and logs the user out everywhere.
      await this.prisma.session.deleteMany({ where: { user_id: payload.sub } });

      return { message: 'Password reset successfully' };
    } catch {
      throw new UnauthorizedException({ code: 'AUTH_INVALID_OR_EXPIRED_RESET_TOKEN', message: 'Invalid or expired reset token' });
    }
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException({ code: 'AUTH_USER_NOT_FOUND', message: 'User not found' });

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) throw new UnauthorizedException({ code: 'AUTH_CURRENT_PASSWORD_INCORRECT', message: 'Current password is incorrect' });

    const password_hash = await bcrypt.hash(newPassword, 12);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password_hash },
    });

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
        creator: true,
        customer: true,
      },
    });

    if (!user) {
      throw new UnauthorizedException();
    }

    return user;
  }

  private async generateTokens(
    userId: string,
    email: string,
    role: UserRole,
  ) {
    const payload = { sub: userId, email, role };

    const [access_token, refresh_token] = await Promise.all([
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_SECRET')!,
        expiresIn: this.configService.get<string>('JWT_EXPIRES_IN') as any,
      }),
      this.jwtService.signAsync(payload, {
        secret: this.configService.get<string>('JWT_REFRESH_SECRET')!,
        expiresIn: this.configService.get<string>('JWT_REFRESH_EXPIRES_IN') as any,
      }),
    ]);

    return { access_token, refresh_token };
  }
}
