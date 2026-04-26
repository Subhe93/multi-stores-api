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
exports.CategoriesService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let CategoriesService = class CategoriesService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(dto) {
        const { translations, ...data } = dto;
        return this.prisma.category.create({
            data: {
                ...data,
                translations: {
                    create: translations,
                },
            },
            include: { translations: true },
        });
    }
    async findAll() {
        return this.prisma.category.findMany({
            where: { parent_id: null },
            include: {
                translations: true,
                children: {
                    include: {
                        translations: true,
                        children: {
                            include: { translations: true },
                        },
                    },
                },
            },
            orderBy: { sort_order: 'asc' },
        });
    }
    async findById(id) {
        const category = await this.prisma.category.findUnique({
            where: { id },
            include: {
                translations: true,
                children: { include: { translations: true } },
                attribute_templates: {
                    include: {
                        template: { include: { translations: true } },
                    },
                },
            },
        });
        if (!category)
            throw new common_1.NotFoundException('Category not found');
        return category;
    }
    async findBySlug(slug) {
        const category = await this.prisma.category.findUnique({
            where: { slug },
            include: {
                translations: true,
                children: { include: { translations: true } },
                attribute_templates: {
                    include: {
                        template: { include: { translations: true } },
                    },
                },
            },
        });
        if (!category)
            throw new common_1.NotFoundException('Category not found');
        return category;
    }
    async update(id, dto) {
        const { translations, ...data } = dto;
        if (translations) {
            await this.prisma.categoryTranslation.deleteMany({
                where: { category_id: id },
            });
        }
        return this.prisma.category.update({
            where: { id },
            data: {
                ...data,
                ...(translations && {
                    translations: { create: translations },
                }),
            },
            include: { translations: true },
        });
    }
    async delete(id) {
        return this.prisma.category.delete({ where: { id } });
    }
    async getAttributeTemplates(id) {
        const category = await this.prisma.category.findUnique({
            where: { id },
            include: {
                attribute_templates: {
                    include: {
                        template: { include: { translations: true } },
                    },
                    orderBy: { template: { sort_order: 'asc' } },
                },
            },
        });
        if (!category)
            throw new common_1.NotFoundException('Category not found');
        return category.attribute_templates.map((cat) => cat.template);
    }
    async linkAttributes(id, dto) {
        await this.prisma.categoryAttributeTemplate.deleteMany({
            where: { category_id: id },
        });
        await this.prisma.categoryAttributeTemplate.createMany({
            data: dto.template_ids.map((template_id) => ({
                category_id: id,
                template_id,
            })),
        });
        return this.getAttributeTemplates(id);
    }
};
exports.CategoriesService = CategoriesService;
exports.CategoriesService = CategoriesService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CategoriesService);
//# sourceMappingURL=categories.service.js.map