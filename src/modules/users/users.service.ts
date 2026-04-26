import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole, UserStatus } from '@prisma/client';

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

    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  async updateStatus(id: string, status: UserStatus) {
    const user = await this.prisma.user.findUnique({ where: { id } });
    if (!user) throw new NotFoundException('User not found');

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
    return config;
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
