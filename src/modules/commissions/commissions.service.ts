import { Injectable } from '@nestjs/common';
import { CommissionStatus, FulfillerType, Prisma } from '@prisma/client';
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
    // Creator earns margin on every order in their store, even when items
    // are fulfilled by a provider — so we filter by store_id, not by
    // fulfiller_id. Provider only earns on items they actually fulfill.
    let where: { order: any } | null = null;

    if (role === 'provider') {
      const provider = await this.prisma.provider.findUnique({ where: { user_id: userId } });
      if (!provider) return { total_earnings: 0, this_month: 0, pending: 0, total_orders: 0 };
      where = {
        order: { items: { some: { fulfiller_id: provider.id } } },
      };
    } else {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
        include: { store: true },
      });
      if (!creator?.store) {
        return { total_earnings: 0, this_month: 0, pending: 0, total_orders: 0 };
      }
      where = {
        order: { store_id: creator.store.id },
      };
    }

    const allCommissions = await this.prisma.orderCommission.findMany({ where });

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

    let totalPlatform = 0;
    let totalProvider = 0;
    let totalCreator = 0;
    let monthPlatform = 0;
    let monthProvider = 0;
    let monthCreator = 0;
    let pendingPlatform = 0;
    let paidPlatform = 0;

    for (const c of allCommissions) {
      const plat = Number(c.platform_amount);
      const prov = Number(c.provider_amount);
      const crea = Number(c.creator_amount);

      totalPlatform += plat;
      totalProvider += prov;
      totalCreator += crea;

      if (c.created_at >= startOfMonth) {
        monthPlatform += plat;
        monthProvider += prov;
        monthCreator += crea;
      }

      if (c.status === CommissionStatus.PENDING || c.status === CommissionStatus.PROCESSING) {
        pendingPlatform += plat;
      } else if (c.status === CommissionStatus.COMPLETED) {
        paidPlatform += plat;
      }
    }

    const totalRevenue = totalPlatform + totalProvider + totalCreator;
    const monthRevenue = monthPlatform + monthProvider + monthCreator;

    const round2 = (n: number) => Math.round(n * 100) / 100;

    return {
      platform_earnings: round2(totalPlatform),
      platform_this_month: round2(monthPlatform),
      provider_earnings: round2(totalProvider),
      provider_this_month: round2(monthProvider),
      creator_earnings: round2(totalCreator),
      creator_this_month: round2(monthCreator),
      total_revenue: round2(totalRevenue),
      total_this_month: round2(monthRevenue),
      pending_platform: round2(pendingPlatform),
      paid_platform: round2(paidPlatform),
      total_orders: allCommissions.length,
    };
  }

  async getAdminList(params: {
    page?: number;
    limit?: number;
    status?: CommissionStatus;
    search?: string;
  }) {
    const page = Math.max(1, params.page ?? 1);
    const limit = Math.min(100, Math.max(1, params.limit ?? 20));
    const skip = (page - 1) * limit;

    const where: Prisma.OrderCommissionWhereInput = {};
    if (params.status) where.status = params.status;
    if (params.search) {
      where.order = {
        OR: [
          { order_number: { contains: params.search, mode: 'insensitive' } },
          {
            customer: {
              OR: [
                { first_name: { contains: params.search, mode: 'insensitive' } },
                { last_name: { contains: params.search, mode: 'insensitive' } },
                { user: { email: { contains: params.search, mode: 'insensitive' } } },
              ],
            },
          },
        ],
      };
    }

    const [rows, total] = await Promise.all([
      this.prisma.orderCommission.findMany({
        where,
        skip,
        take: limit,
        orderBy: { created_at: 'desc' },
        include: {
          order: {
            select: {
              id: true,
              order_number: true,
              status: true,
              total: true,
              subtotal: true,
              discount_amount: true,
              created_at: true,
              store_id: true,
              customer: {
                select: {
                  id: true,
                  first_name: true,
                  last_name: true,
                  user: { select: { email: true } },
                },
              },
              items: {
                select: { fulfiller_type: true, fulfiller_id: true },
              },
            },
          },
        },
      }),
      this.prisma.orderCommission.count({ where }),
    ]);

    // Collect unique provider/creator/store ids for a bulk lookup so we don't N+1.
    const providerIds = new Set<string>();
    const storeIds = new Set<string>();
    const creatorFulfillerIds = new Set<string>();

    for (const r of rows) {
      if (r.order.store_id) storeIds.add(r.order.store_id);
      for (const it of r.order.items) {
        if (it.fulfiller_type === FulfillerType.PROVIDER) providerIds.add(it.fulfiller_id);
        else if (it.fulfiller_type === FulfillerType.CREATOR) creatorFulfillerIds.add(it.fulfiller_id);
      }
    }

    const [providers, stores, creatorsByFulfiller] = await Promise.all([
      providerIds.size > 0
        ? this.prisma.provider.findMany({
            where: { id: { in: [...providerIds] } },
            select: { id: true, company_name: true },
          })
        : Promise.resolve([]),
      storeIds.size > 0
        ? this.prisma.store.findMany({
            where: { id: { in: [...storeIds] } },
            select: {
              id: true,
              name: true,
              slug: true,
              creator: { select: { id: true, display_name: true } },
            },
          })
        : Promise.resolve([]),
      creatorFulfillerIds.size > 0
        ? this.prisma.creator.findMany({
            where: { id: { in: [...creatorFulfillerIds] } },
            select: { id: true, display_name: true },
          })
        : Promise.resolve([]),
    ]);

    const providerMap = new Map<string, string>(
      providers.map((p) => [p.id, p.company_name] as const),
    );
    const storeMap = new Map<string, (typeof stores)[number]>(
      stores.map((s) => [s.id, s] as const),
    );
    const creatorFulfillerMap = new Map<string, string>(
      creatorsByFulfiller.map((c) => [c.id, c.display_name] as const),
    );

    const data = rows.map((r) => {
      const storeInfo = r.order.store_id ? storeMap.get(r.order.store_id) : null;
      const providerNames = new Set<string>();
      for (const it of r.order.items) {
        if (it.fulfiller_type === FulfillerType.PROVIDER) {
          const name = providerMap.get(it.fulfiller_id);
          if (name) providerNames.add(name);
        } else if (it.fulfiller_type === FulfillerType.CREATOR && !storeInfo) {
          // Direct creator-fulfilled item with no store context — surface the creator name.
          const name = creatorFulfillerMap.get(it.fulfiller_id);
          if (name) providerNames.add(name);
        }
      }

      return {
        id: r.id,
        order_id: r.order_id,
        order_number: r.order.order_number,
        order_status: r.order.status,
        order_total: Number(r.order.total),
        order_subtotal: Number(r.order.subtotal),
        order_discount: Number(r.order.discount_amount),
        platform_amount: Number(r.platform_amount),
        provider_amount: Number(r.provider_amount),
        creator_amount: Number(r.creator_amount),
        currency: r.currency,
        status: r.status,
        created_at: r.created_at,
        customer: r.order.customer
          ? {
              id: r.order.customer.id,
              name: `${r.order.customer.first_name} ${r.order.customer.last_name}`.trim(),
              email: r.order.customer.user?.email ?? null,
            }
          : null,
        store: storeInfo
          ? { id: storeInfo.id, name: storeInfo.name, slug: storeInfo.slug }
          : null,
        creator: storeInfo?.creator
          ? { id: storeInfo.creator.id, name: storeInfo.creator.display_name }
          : null,
        providers: [...providerNames],
      };
    });

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
