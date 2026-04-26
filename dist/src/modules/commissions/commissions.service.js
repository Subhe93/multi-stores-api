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
        let profile;
        if (role === 'provider') {
            profile = await this.prisma.provider.findUnique({ where: { user_id: userId } });
        }
        else {
            profile = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        }
        if (!profile)
            return { total_earnings: 0, this_month: 0, pending: 0 };
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
        const totalPlatform = allCommissions.reduce((sum, c) => sum + Number(c.platform_amount), 0);
        const thisMonth = allCommissions
            .filter((c) => c.created_at >= startOfMonth)
            .reduce((sum, c) => sum + Number(c.platform_amount), 0);
        const totalRevenue = allCommissions.reduce((sum, c) => sum + Number(c.provider_amount) + Number(c.platform_amount) + Number(c.creator_amount), 0);
        return {
            platform_earnings: Math.round(totalPlatform * 100) / 100,
            platform_this_month: Math.round(thisMonth * 100) / 100,
            total_revenue: Math.round(totalRevenue * 100) / 100,
            total_orders: allCommissions.length,
        };
    }
};
exports.CommissionsService = CommissionsService;
exports.CommissionsService = CommissionsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CommissionsService);
//# sourceMappingURL=commissions.service.js.map