import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class CommissionsService {
  constructor(private prisma: PrismaService) {}

  async getByOrder(orderId: string) {
    return this.prisma.orderCommission.findUnique({
      where: { order_id: orderId },
    });
  }

  async getSummary(userId: string, role: 'provider' | 'creator') {
    // جلب كل الطلبات التي يكون المستخدم هو المنفذ
    let profile: any;
    if (role === 'provider') {
      profile = await this.prisma.provider.findUnique({ where: { user_id: userId } });
    } else {
      profile = await this.prisma.creator.findUnique({ where: { user_id: userId } });
    }

    if (!profile) return { total_earnings: 0, this_month: 0, pending: 0 };

    const allCommissions = await this.prisma.orderCommission.findMany({
      where: {
        order: {
          items: { some: { fulfiller_id: profile.id } },
        },
      },
    });

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const amountField = role === 'provider' ? 'provider_amount' : 'creator_amount';

    const totalEarnings = allCommissions.reduce(
      (sum, c) => sum + Number(c[amountField]),
      0,
    );

    const thisMonth = allCommissions
      .filter((c) => c.created_at >= startOfMonth)
      .reduce((sum, c) => sum + Number(c[amountField]), 0);

    const pending = allCommissions
      .filter((c) => c.status === 'PENDING')
      .reduce((sum, c) => sum + Number(c[amountField]), 0);

    return {
      total_earnings: Math.round(totalEarnings * 100) / 100,
      this_month: Math.round(thisMonth * 100) / 100,
      pending: Math.round(pending * 100) / 100,
      total_orders: allCommissions.length,
    };
  }

  async getPlatformSummary() {
    const allCommissions = await this.prisma.orderCommission.findMany();

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const totalPlatform = allCommissions.reduce(
      (sum, c) => sum + Number(c.platform_amount),
      0,
    );

    const thisMonth = allCommissions
      .filter((c) => c.created_at >= startOfMonth)
      .reduce((sum, c) => sum + Number(c.platform_amount), 0);

    const totalRevenue = allCommissions.reduce(
      (sum, c) =>
        sum + Number(c.provider_amount) + Number(c.platform_amount) + Number(c.creator_amount),
      0,
    );

    return {
      platform_earnings: Math.round(totalPlatform * 100) / 100,
      platform_this_month: Math.round(thisMonth * 100) / 100,
      total_revenue: Math.round(totalRevenue * 100) / 100,
      total_orders: allCommissions.length,
    };
  }
}
