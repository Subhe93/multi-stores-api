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
exports.PagesService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let PagesService = class PagesService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async findByStore(storeId) {
        return this.prisma.staticPage.findMany({
            where: { store_id: storeId },
            include: { translations: true, blocks: { include: { translations: true }, orderBy: { sort_order: 'asc' } } },
            orderBy: { sort_order: 'asc' },
        });
    }
    async findById(id) {
        const page = await this.prisma.staticPage.findUnique({
            where: { id },
            include: { translations: true, blocks: { include: { translations: true }, orderBy: { sort_order: 'asc' } } },
        });
        if (!page)
            throw new common_1.NotFoundException('Page not found');
        return page;
    }
    async create(storeId, dto) {
        const { translations, ...data } = dto;
        return this.prisma.staticPage.create({
            data: {
                store_id: storeId,
                ...data,
                ...(translations && { translations: { create: translations } }),
            },
            include: { translations: true },
        });
    }
    async update(id, dto) {
        const { translations, ...data } = dto;
        if (translations) {
            await this.prisma.staticPageTranslation.deleteMany({ where: { page_id: id } });
        }
        return this.prisma.staticPage.update({
            where: { id },
            data: {
                ...data,
                ...(translations && { translations: { create: translations } }),
            },
            include: { translations: true },
        });
    }
    async delete(id) {
        const page = await this.prisma.staticPage.findUnique({ where: { id } });
        if (!page)
            throw new common_1.NotFoundException('Page not found');
        if (page.is_required)
            throw new common_1.NotFoundException('Cannot delete required page');
        return this.prisma.staticPage.delete({ where: { id } });
    }
};
exports.PagesService = PagesService;
exports.PagesService = PagesService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], PagesService);
//# sourceMappingURL=pages.service.js.map