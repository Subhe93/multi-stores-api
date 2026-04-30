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
let StoresService = class StoresService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
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
        return this.prisma.store.update({
            where: { creator_id: creator.id },
            data: dto,
            include: { language_config: true },
        });
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
        return this.prisma.store.update({
            where: { id: store.id },
            data: dto,
            include: { language_config: true },
        });
    }
    async updateTheme(userId, dto) {
        const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        return this.prisma.store.update({
            where: { creator_id: creator.id },
            data: { theme_config: dto.theme_config },
        });
    }
    async updateLanguages(userId, dto) {
        const creator = await this.prisma.creator.findUnique({ where: { user_id: userId } });
        if (!creator)
            throw new common_1.NotFoundException('Creator not found');
        const store = await this.prisma.store.findUnique({ where: { creator_id: creator.id } });
        if (!store)
            throw new common_1.NotFoundException('Store not found');
        return this.prisma.storeLanguageConfig.upsert({
            where: { store_id: store.id },
            update: dto,
            create: { store_id: store.id, ...dto },
        });
    }
};
exports.StoresService = StoresService;
exports.StoresService = StoresService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], StoresService);
//# sourceMappingURL=stores.service.js.map