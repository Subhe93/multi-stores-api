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
exports.UsersService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let UsersService = class UsersService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findAll(page = 1, limit = 20, filters) {
        const skip = (page - 1) * limit;
        const where = {};
        if (filters?.role)
            where.role = filters.role;
        if (filters?.status)
            where.status = filters.status;
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
    async findById(id) {
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
        if (!user)
            throw new common_1.NotFoundException('User not found');
        return user;
    }
    async updateStatus(id, status) {
        const user = await this.prisma.user.findUnique({ where: { id } });
        if (!user)
            throw new common_1.NotFoundException('User not found');
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
        const [totalUsers, totalProviders, totalCreators, totalCustomers, pendingProviders, pendingCreators] = await Promise.all([
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
    async updatePlatformConfig(data) {
        let config = await this.prisma.platformConfig.findFirst();
        if (!config) {
            return this.prisma.platformConfig.create({ data: data });
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
};
exports.UsersService = UsersService;
exports.UsersService = UsersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], UsersService);
//# sourceMappingURL=users.service.js.map