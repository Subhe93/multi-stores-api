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
exports.ProvidersService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let ProvidersService = class ProvidersService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(userId, dto) {
        return this.prisma.provider.create({
            data: {
                user_id: userId,
                ...dto,
            },
        });
    }
    async findByUserId(userId) {
        const provider = await this.prisma.provider.findUnique({
            where: { user_id: userId },
        });
        if (!provider)
            throw new common_1.NotFoundException('Provider profile not found');
        return provider;
    }
    async findById(id) {
        const provider = await this.prisma.provider.findUnique({
            where: { id },
            include: { user: { select: { email: true, status: true } } },
        });
        if (!provider)
            throw new common_1.NotFoundException('Provider not found');
        return provider;
    }
    async update(userId, dto) {
        return this.prisma.provider.update({
            where: { user_id: userId },
            data: dto,
        });
    }
    async findAll(page = 1, limit = 20) {
        const skip = (page - 1) * limit;
        const [data, total] = await Promise.all([
            this.prisma.provider.findMany({
                skip,
                take: limit,
                include: { user: { select: { email: true, status: true } } },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.provider.count(),
        ]);
        return {
            data,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }
    async verify(id) {
        return this.prisma.provider.update({
            where: { id },
            data: { verified: true },
        });
    }
    async findStoresUsingProvider(userId, page = 1, limit = 20) {
        const provider = await this.prisma.provider.findUnique({
            where: { user_id: userId },
            select: { id: true },
        });
        if (!provider)
            throw new common_1.NotFoundException('Provider profile not found');
        const skip = (page - 1) * limit;
        const baseWhere = {
            creator: {
                custom_products: {
                    some: { product: { provider_id: provider.id } },
                },
            },
        };
        const [stores, total] = await Promise.all([
            this.prisma.store.findMany({
                where: baseWhere,
                skip,
                take: limit,
                include: {
                    creator: { select: { display_name: true, avatar_url: true, verified: true } },
                    language_config: { select: { primary_locale: true } },
                    _count: { select: { static_pages: true } },
                },
                orderBy: { created_at: 'desc' },
            }),
            this.prisma.store.count({ where: baseWhere }),
        ]);
        const storesWithCounts = await Promise.all(stores.map(async (s) => {
            const productsCount = await this.prisma.customProduct.count({
                where: {
                    creator_id: s.creator_id,
                    product: { provider_id: provider.id },
                },
            });
            return { ...s, products_using_count: productsCount };
        }));
        return {
            data: storesWithCounts,
            meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
        };
    }
    async findStoreForProvider(userId, storeId) {
        const provider = await this.prisma.provider.findUnique({
            where: { user_id: userId },
            select: { id: true },
        });
        if (!provider)
            throw new common_1.NotFoundException('Provider profile not found');
        const store = await this.prisma.store.findUnique({
            where: { id: storeId },
            include: {
                creator: {
                    select: {
                        display_name: true,
                        avatar_url: true,
                        cover_url: true,
                        bio: true,
                        verified: true,
                    },
                },
                language_config: true,
                static_pages: {
                    where: { status: 'PUBLISHED' },
                    include: { translations: true },
                    orderBy: { sort_order: 'asc' },
                },
            },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const usesProvider = await this.prisma.customProduct.findFirst({
            where: {
                creator_id: store.creator_id,
                product: { provider_id: provider.id },
            },
            select: { id: true },
        });
        if (!usesProvider) {
            throw new common_1.NotFoundException('Store does not use your products');
        }
        const customProducts = await this.prisma.customProduct.findMany({
            where: {
                creator_id: store.creator_id,
                product: { provider_id: provider.id },
            },
            include: {
                translations: true,
                mockup_images: { orderBy: { sort_order: 'asc' }, take: 1 },
                selected_variants: {
                    select: {
                        custom_price: true,
                        variant: { select: { price_adjustment: true } },
                    },
                },
                product: {
                    include: {
                        translations: true,
                        images: { orderBy: { sort_order: 'asc' }, take: 1 },
                    },
                },
            },
            orderBy: { created_at: 'desc' },
            take: 50,
        });
        return { ...store, custom_products_using: customProducts };
    }
};
exports.ProvidersService = ProvidersService;
exports.ProvidersService = ProvidersService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ProvidersService);
//# sourceMappingURL=providers.service.js.map