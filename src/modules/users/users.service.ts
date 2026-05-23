import {
  Injectable,
  NotFoundException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole, UserStatus } from '@prisma/client';

interface CreateUserPayload {
  email: string;
  password: string;
  role: UserRole;
  status?: UserStatus;
  avatar_url?: string;
  // Provider
  company_name?: string;
  description?: string;
  country?: string;
  phone?: string;
  verified?: boolean;
  // Creator
  display_name?: string;
  bio?: string;
  // Customer
  first_name?: string;
  last_name?: string;
}

interface UpdateUserPayload {
  email?: string;
  status?: UserStatus;
  avatar_url?: string | null;
  // Provider
  company_name?: string;
  description?: string | null;
  country?: string;
  phone?: string | null;
  verified?: boolean;
  logo_url?: string | null;
  // Creator
  display_name?: string;
  bio?: string | null;
  cover_url?: string | null;
  // Customer
  first_name?: string;
  last_name?: string;
}

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  async findAll(
    page = 1,
    limit = 20,
    filters?: { role?: UserRole; status?: UserStatus; search?: string },
  ) {
    const skip = (page - 1) * limit;
    const where: any = {};

    if (filters?.role) where.role = filters.role;
    if (filters?.status) where.status = filters.status;
    if (filters?.search) {
      where.email = { contains: filters.search, mode: 'insensitive' };
    }

    const [data, total] = await Promise.all([
      this.prisma.user.findMany({
        skip,
        take: limit,
        where,
        select: {
          id: true,
          email: true,
          role: true,
          status: true,
          avatar_url: true,
          created_at: true,
          provider: { select: { company_name: true, verified: true } },
          creator: { select: { display_name: true, verified: true } },
          customer: { select: { first_name: true, last_name: true } },
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findById(id: string) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        avatar_url: true,
        created_at: true,
        updated_at: true,
        provider: true,
        creator: true,
        customer: { include: { addresses: true } },
      },
    });

    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });
    return user;
  }

  async create(dto: CreateUserPayload) {
    if (!dto.email || !dto.password || !dto.role) {
      throw new BadRequestException({ code: 'USER_MISSING_REQUIRED_FIELDS', message: 'email, password and role are required' });
    }
    if (dto.password.length < 8) {
      throw new BadRequestException({ code: 'USER_PASSWORD_TOO_SHORT', message: 'Password must be at least 8 characters' });
    }

    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) throw new ConflictException({ code: 'USER_EMAIL_EXISTS', message: 'Email already registered' });

    const password_hash = await bcrypt.hash(dto.password, 12);

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        password_hash,
        role: dto.role,
        status: dto.status ?? UserStatus.ACTIVE,
        avatar_url: dto.avatar_url,
      },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        avatar_url: true,
        created_at: true,
      },
    });

    if (dto.role === UserRole.PROVIDER) {
      await this.prisma.provider.create({
        data: {
          user_id: user.id,
          company_name: dto.company_name || 'New Company',
          description: dto.description,
          country: dto.country || 'US',
          phone: dto.phone,
          verified: dto.verified ?? false,
        },
      });
    } else if (dto.role === UserRole.CREATOR) {
      await this.prisma.creator.create({
        data: {
          user_id: user.id,
          display_name: dto.display_name || 'New Creator',
          bio: dto.bio,
          phone: dto.phone,
          verified: dto.verified ?? false,
        },
      });
    } else if (dto.role === UserRole.CUSTOMER) {
      await this.prisma.customer.create({
        data: {
          user_id: user.id,
          first_name: dto.first_name || '',
          last_name: dto.last_name || '',
          phone: dto.phone,
        },
      });
    }

    return this.findById(user.id);
  }

  async update(id: string, dto: UpdateUserPayload) {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { provider: true, creator: true, customer: true },
    });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });

    if (dto.email && dto.email !== user.email) {
      const conflict = await this.prisma.user.findUnique({
        where: { email: dto.email },
      });
      if (conflict) throw new ConflictException({ code: 'USER_EMAIL_IN_USE', message: 'Email already in use' });
    }

    const userUpdate: Record<string, any> = {};
    if (dto.email !== undefined) userUpdate.email = dto.email;
    if (dto.status !== undefined) userUpdate.status = dto.status;
    if (dto.avatar_url !== undefined) userUpdate.avatar_url = dto.avatar_url;

    if (Object.keys(userUpdate).length > 0) {
      await this.prisma.user.update({ where: { id }, data: userUpdate });
    }

    if (user.role === UserRole.PROVIDER && user.provider) {
      const providerUpdate: Record<string, any> = {};
      if (dto.company_name !== undefined) providerUpdate.company_name = dto.company_name;
      if (dto.description !== undefined) providerUpdate.description = dto.description;
      if (dto.country !== undefined) providerUpdate.country = dto.country;
      if (dto.phone !== undefined) providerUpdate.phone = dto.phone;
      if (dto.verified !== undefined) providerUpdate.verified = dto.verified;
      if (dto.logo_url !== undefined) providerUpdate.logo_url = dto.logo_url;
      if (Object.keys(providerUpdate).length > 0) {
        await this.prisma.provider.update({
          where: { id: user.provider.id },
          data: providerUpdate,
        });
      }
    } else if (user.role === UserRole.CREATOR && user.creator) {
      const creatorUpdate: Record<string, any> = {};
      if (dto.display_name !== undefined) creatorUpdate.display_name = dto.display_name;
      if (dto.bio !== undefined) creatorUpdate.bio = dto.bio;
      if (dto.phone !== undefined) creatorUpdate.phone = dto.phone;
      if (dto.verified !== undefined) creatorUpdate.verified = dto.verified;
      if (dto.avatar_url !== undefined) creatorUpdate.avatar_url = dto.avatar_url;
      if (dto.cover_url !== undefined) creatorUpdate.cover_url = dto.cover_url;
      if (Object.keys(creatorUpdate).length > 0) {
        await this.prisma.creator.update({
          where: { id: user.creator.id },
          data: creatorUpdate,
        });
      }
    } else if (user.role === UserRole.CUSTOMER && user.customer) {
      const customerUpdate: Record<string, any> = {};
      if (dto.first_name !== undefined) customerUpdate.first_name = dto.first_name;
      if (dto.last_name !== undefined) customerUpdate.last_name = dto.last_name;
      if (dto.phone !== undefined) customerUpdate.phone = dto.phone;
      if (Object.keys(customerUpdate).length > 0) {
        await this.prisma.customer.update({
          where: { id: user.customer.id },
          data: customerUpdate,
        });
      }
    }

    return this.findById(id);
  }

  async updateStatus(id: string, status: UserStatus) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });

    return this.prisma.user.update({
      where: { id },
      data: { status },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
      },
    });
  }

  async resetPassword(id: string, newPassword: string) {
    if (!newPassword || newPassword.length < 8) {
      throw new BadRequestException({ code: 'USER_PASSWORD_TOO_SHORT', message: 'Password must be at least 8 characters' });
    }
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });

    const password_hash = await bcrypt.hash(newPassword, 12);

    await this.prisma.user.update({
      where: { id },
      data: { password_hash },
    });

    // Invalidate all active sessions so the user is forced to re-login.
    await this.prisma.session.deleteMany({ where: { user_id: id } });

    return { message: 'Password reset successfully' };
  }

  async remove(id: string, actingUserId: string) {
    if (id === actingUserId) {
      throw new ForbiddenException({ code: 'USER_CANNOT_DELETE_SELF', message: 'You cannot delete your own account' });
    }
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException({ code: 'USER_NOT_FOUND', message: 'User not found' });

    if (user.role === UserRole.ADMIN) {
      const adminCount = await this.prisma.user.count({
        where: { role: UserRole.ADMIN },
      });
      if (adminCount <= 1) {
        throw new ForbiddenException({ code: 'USER_CANNOT_DELETE_LAST_ADMIN', message: 'Cannot delete the last admin account' });
      }
    }

    await this.prisma.user.delete({ where: { id } });

    return { message: 'User deleted successfully' };
  }

  async getDashboardStats() {
    const [totalUsers, totalProviders, totalCreators, totalCustomers, pendingProviders, pendingCreators] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.provider.count(),
        this.prisma.creator.count(),
        this.prisma.customer.count(),
        this.prisma.provider.count({ where: { verified: false } }),
        this.prisma.creator.count({ where: { verified: false } }),
      ]);

    return {
      totalUsers,
      totalProviders,
      totalCreators,
      totalCustomers,
      pendingProviders,
      pendingCreators,
    };
  }

  async getPlatformConfig() {
    let config = await this.prisma.platformConfig.findFirst();
    if (!config) {
      config = await this.prisma.platformConfig.create({ data: {} });
    }
    // This endpoint is readable by providers/creators, so never expose the
    // platform Stripe/SMTP credentials here. They are managed via the admin-only
    // payments / mail settings APIs instead.
    const {
      stripe_secret_key: _s,
      stripe_publishable_key: _p,
      stripe_webhook_secret: _w,
      smtp_host: _sh,
      smtp_port: _sp,
      smtp_secure: _ss,
      smtp_user: _su,
      smtp_pass: _spw,
      mail_from: _mf,
      ...safe
    } = config;
    void _s;
    void _p;
    void _w;
    void _sh;
    void _sp;
    void _ss;
    void _su;
    void _spw;
    void _mf;
    return safe;
  }

  async updatePlatformConfig(data: {
    commission_type?: string;
    commission_value?: number;
    default_currency?: string;
    default_locale?: string;
    supported_locales?: string[];
    platform_name?: string;
    support_email?: string;
    min_order_amount?: number | null;
    require_provider_approval?: boolean;
    require_creator_approval?: boolean;
  }) {
    let config = await this.prisma.platformConfig.findFirst();
    if (!config) {
      return this.prisma.platformConfig.create({ data: data as any });
    }
    return this.prisma.platformConfig.update({
      where: { id: config.id },
      data,
    });
  }

  async getRecentUsers(limit = 5) {
    return this.prisma.user.findMany({
      take: limit,
      orderBy: { created_at: 'desc' },
      select: {
        id: true,
        email: true,
        role: true,
        status: true,
        created_at: true,
        provider: { select: { company_name: true } },
        creator: { select: { display_name: true } },
        customer: { select: { first_name: true, last_name: true } },
      },
    });
  }
}
