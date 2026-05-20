"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CommissionsService = void 0;
const common_1 = require("@nestjs/common");
const client_1 = require("@prisma/client");
const prisma_service_1 = require("../../prisma/prisma.service");
let CommissionsService = class CommissionsService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getByOrder(orderId) {
        return this.prisma.orderCommission.findUnique({
            where: { order_id: orderId },
        });
    }
    async getSummary(userId, role) {
        let where = null;
        if (role === 'provider') {
            const provider = await this.prisma.provider.findUnique({ where: { user_id: userId } });
            if (!provider)
                return { total_earnings: 0, this_month: 0, pending: 0, total_orders: 0 };
            where = {
                order: { items: { some: { fulfiller_id: provider.id } } },
            };
        }
        else {
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
        const totalEarnings = allCommissions.reduce((sum, c) => sum + Number(c[amountField]), 0);
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
            if (c.status === client_1.CommissionStatus.PENDING || c.status === client_1.CommissionStatus.PROCESSING) {
                pendingPlatform += plat;
            }
            else if (c.status === client_1.CommissionStatus.COMPLETED) {
                paidPlatform += plat;
            }
        }
        const totalRevenue = totalPlatform + totalProvider + totalCreator;
        const monthRevenue = monthPlatform + monthProvider + monthCreator;
        const round2 = (n) => Math.round(n * 100) / 100;
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
    async getAdminList(params) {
        const page = Math.max(1, params.page ?? 1);
        const limit = Math.min(100, Math.max(1, params.limit ?? 20));
        const skip = (page - 1) * limit;
        const where = {};
        if (params.status)
            where.status = params.status;
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
        const providerIds = new Set();
        const storeIds = new Set();
        const creatorFulfillerIds = new Set();
        for (const r of rows) {
            if (r.order.store_id)
                storeIds.add(r.order.store_id);
            for (const it of r.order.items) {
                if (it.fulfiller_type === client_1.FulfillerType.PROVIDER)
                    providerIds.add(it.fulfiller_id);
                else if (it.fulfiller_type === client_1.FulfillerType.CREATOR)
                    creatorFulfillerIds.add(it.fulfiller_id);
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
        const providerMap = new Map(providers.map((p) => [p.id, p.company_name]));
        const storeMap = new Map(stores.map((s) => [s.id, s]));
        const creatorFulfillerMap = new Map(creatorsByFulfiller.map((c) => [c.id, c.display_name]));
        const data = rows.map((r) => {
            const storeInfo = r.order.store_id ? storeMap.get(r.order.store_id) : null;
            const providerNames = new Set();
            for (const it of r.order.items) {
                if (it.fulfiller_type === client_1.FulfillerType.PROVIDER) {
                    const name = providerMap.get(it.fulfiller_id);
                    if (name)
                        providerNames.add(name);
                }
                else if (it.fulfiller_type === client_1.FulfillerType.CREATOR && !storeInfo) {
                    const name = creatorFulfillerMap.get(it.fulfiller_id);
                    if (name)
                        providerNames.add(name);
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
};
exports.CommissionsService = CommissionsService;
exports.CommissionsService = CommissionsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CommissionsService);
//# sourceMappingURL=commissions.service.js.map