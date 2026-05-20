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
exports.StoresService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
const revalidation_service_1 = require("../../common/revalidation/revalidation.service");
let StoresService = class StoresService {
    prisma;
    revalidation;
    constructor(prisma, revalidation) {
        this.prisma = prisma;
        this.revalidation = revalidation;
    }
    async create(userId, dto) {
        const creator = await this.prisma.creator.findUnique({
            where: { user_id: userId },
        });
        if (!creator)
            throw new common_1.NotFoundException('Creator profile not found');
        const existing = await this.prisma.store.findUnique({
            where: { slug: dto.slug },
        });
        if (existing)
            throw new common_1.ConflictException('Store slug already taken');
        const { primary_locale, secondary_locales, ...storeData } = dto;
        const store = await this.prisma.store.create({
            data: {
                creator_id: creator.id,
                ...storeData,
                language_config: {
                    create: {
                        primary_locale: primary_locale || 'en',
                        secondary_locales: secondary_locales || [],
                    },
                },
                static_pages: {
                    create: [
                        { type: 'ABOUT', slug: 'about', is_required: true, sort_order: 1, status: 'DRAFT' },
                        { type: 'CONTACT', slug: 'contact', is_required: true, sort_order: 2, status: 'DRAFT' },
                        { type: 'PRIVACY_POLICY', slug: 'privacy-policy', is_required: true, sort_order: 3, status: 'DRAFT' },
                        { type: 'TERMS', slug: 'terms', is_required: true, sort_order: 4, status: 'DRAFT' },
                        { type: 'SHIPPING_POLICY', slug: 'shipping-policy', is_required: true, sort_order: 5, status: 'DRAFT' },
                        { type: 'RETURN_POLICY', slug: 'return-policy', is_required: true, sort_order: 6, status: 'DRAFT' },
                    ],
                },
            },
            include: {
                language_config: true,
                static_pages: true,
                creator: { select: { display_name: true, avatar_url: true } },
            },
        });
        return store;
    }
    async findByCreator(userId) {
        const creator = await this.prisma.creator.findUnique({
            where: { user_id: userId },
        });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        const store = await this.prisma.store.findUnique({
            where: { creator_id: creator.id },
            include: {
                language_config: true,
                static_pages: { include: { translations: true } },
                creator: { select: { display_name: true, avatar_url: true, bio: true } },
            },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        return store;
    }
    async findBySlug(slug) {
        const store = await this.prisma.store.findUnique({
            where: { slug },
            include: {
                language_config: true,
                static_pages: {
                    where: { status: 'PUBLISHED' },
                    include: { translations: true },
                },
                creator: { select: { display_name: true, avatar_url: true, bio: true, cover_url: true } },
            },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        return store;
    }
    async update(userId, dto) {
        const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        if (dto.slug) {
            const conflict = await this.prisma.store.findFirst({
                where: { slug: dto.slug, creator_id: { not: creator.id } },
                select: { id: true },
            });
            if (conflict)
                throw new common_1.ConflictException('Store slug already taken');
        }
        const store = await this.prisma.store.update({
            where: { creator_id: creator.id },
            data: dto,
            include: { language_config: true },
        });
        await this.revalidation.revalidateStoreBySlug(store.slug);
        return store;
    }
    async findByCreatorId(creatorId) {
        const store = await this.prisma.store.findUnique({
            where: { creator_id: creatorId },
            include: {
                language_config: true,
                creator: { select: { display_name: true, avatar_url: true } },
            },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        return store;
    }
    async adminUpdateByCreatorId(creatorId, dto) {
        const store = await this.prisma.store.findUnique({
            where: { creator_id: creatorId },
            select: { id: true },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        if (dto.slug) {
            const conflict = await this.prisma.store.findFirst({
                where: { slug: dto.slug, id: { not: store.id } },
                select: { id: true },
            });
            if (conflict)
                throw new common_1.ConflictException('Store slug already taken');
        }
        const updated = await this.prisma.store.update({
            where: { id: store.id },
            data: dto,
            include: { language_config: true },
        });
        await this.revalidation.revalidateStoreBySlug(updated.slug);
        return updated;
    }
    async updateTheme(userId, dto) {
        const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        const store = await this.prisma.store.update({
            where: { creator_id: creator.id },
            data: { theme_config: dto.theme_config },
        });
        await this.revalidation.revalidateStoreBySlug(store.slug);
        return store;
    }
    async updateThemeSelection(userId, dto) {
        const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        const data = {};
        if (dto.theme_key !== undefined)
            data.theme_key = dto.theme_key;
        if (dto.theme_customizations !== undefined)
            data.theme_customizations = dto.theme_customizations;
        if (dto.reset_customizations) {
            data.theme_customizations = {};
            const store = await this.prisma.store.findUnique({ where: { creator_id: creator.id } });
            const cfg = (store?.theme_config || {});
            const { primaryColor, secondaryColor, fontFamily, typography, ...rest } = cfg;
            void primaryColor;
            void secondaryColor;
            void fontFamily;
            void typography;
            data.theme_config = rest;
        }
        const store = await this.prisma.store.update({
            where: { creator_id: creator.id },
            data,
        });
        await this.revalidation.revalidateStoreBySlug(store.slug);
        return store;
    }
    async flushCache(userId) {
        const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        const store = await this.prisma.store.findUnique({
            where: { creator_id: creator.id },
            select: { slug: true },
        });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        await this.revalidation.revalidateStoreBySlug(store.slug);
        return { flushed: true, slug: store.slug };
    }
    async updateLanguages(userId, dto) {
        const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        const store = await this.prisma.store.findUnique({ where: { creator_id: creator.id } });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        const config = await this.prisma.storeLanguageConfig.upsert({
            where: { store_id: store.id },
            update: dto,
            create: { store_id: store.id, ...dto },
        });
        await this.revalidation.revalidateStoreById(store.id);
        return config;
    }
};
exports.StoresService = StoresService;
exports.StoresService = StoresService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService,
        revalidation_service_1.RevalidationService])
], StoresService);
//# sourceMappingURL=stores.service.js.map