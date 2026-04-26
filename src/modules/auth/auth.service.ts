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

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private configService: ConfigService,
  ) {}

  async register(dto: RegisterDto) {
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    if (dto.role === UserRole.ADMIN) {
      throw new ForbiddenException('Cannot register as admin');
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

    return { user, ...tokens };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await bcrypt.compare(dto.password, user.password_hash);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (user.status !== 'ACTIVE') {
      throw new ForbiddenException('Account is not active');
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

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user || user.status !== 'ACTIVE') {
        throw new UnauthorizedException();
      }

      return this.generateTokens(user.id, user.email, user.role);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  async logout(userId: string, refreshToken: string) {
    // حذف كل sessions المستخدم — إبطال التوكن
    await this.prisma.session.deleteMany({
      where: { user_id: userId },
    });

    // حفظ الـ refresh token المُبطل (blacklist)
    await this.prisma.session.create({
      data: {
        user_id: userId,
        token: refreshToken,
        expires_at: new Date(0), // منتهي الصلاحية = مُبطل
      },
    });

    return { message: 'Logged out successfully' };
  }

  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
    });

    // لا نكشف إذا كان الإيميل موجود أم لا — لأسباب أمنية
    if (!user) {
      return { message: 'If the email exists, a reset link will be sent' };
    }

    // إنشاء توكن إعادة تعيين (صالح 1 ساعة)
    const resetToken = await this.jwtService.signAsync(
      { sub: user.id, type: 'password_reset' },
      {
        secret: this.configService.get<string>('JWT_SECRET')!,
        expiresIn: '1h' as any,
      },
    );

    // حفظ التوكن في الـ sessions
    await this.prisma.session.create({
      data: {
        user_id: user.id,
        token: resetToken,
        expires_at: new Date(Date.now() + 60 * 60 * 1000), // ساعة
      },
    });

    // TODO: إرسال إيميل مع رابط إعادة التعيين
    // await this.mailService.sendResetEmail(user.email, resetToken);

    return { message: 'If the email exists, a reset link will be sent' };
  }

  async resetPassword(token: string, newPassword: string) {
    try {
      const payload = this.jwtService.verify(token, {
        secret: this.configService.get<string>('JWT_SECRET')!,
      });

      if (payload.type !== 'password_reset') {
        throw new UnauthorizedException('Invalid reset token');
      }

      // التأكد أن التوكن موجود في الـ sessions (لم يُستخدم سابقاً)
      const session = await this.prisma.session.findUnique({
        where: { token },
      });

      if (!session || session.expires_at < new Date()) {
        throw new UnauthorizedException('Reset token expired or already used');
      }

      const password_hash = await bcrypt.hash(newPassword, 12);

      await this.prisma.user.update({
        where: { id: payload.sub },
        data: { password_hash },
      });

      // حذف التوكن بعد الاستخدام
      await this.prisma.session.delete({ where: { token } });

      return { message: 'Password reset successfully' };
    } catch {
      throw new UnauthorizedException('Invalid or expired reset token');
    }
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('User not found');

    const valid = await bcrypt.compare(currentPassword, user.password_hash);
    if (!valid) throw new UnauthorizedException('Current password is incorrect');

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
