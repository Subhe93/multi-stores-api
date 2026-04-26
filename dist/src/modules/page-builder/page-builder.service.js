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
exports.PageBuilderService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let PageBuilderService = class PageBuilderService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async getBlocks(pageId) {
        return this.prisma.pageBlock.findMany({
            where: { page_id: pageId },
            include: { translations: true },
            orderBy: { sort_order: 'asc' },
        });
    }
    async addBlock(pageId, dto) {
        const page = await this.prisma.staticPage.findUnique({ where: { id: pageId } });
        if (!page)
            throw new common_1.NotFoundException('Page not found');
        const { translations, ...data } = dto;
        return this.prisma.pageBlock.create({
            data: {
                page_id: pageId,
                ...data,
                ...(translations && { translations: { create: translations } }),
            },
            include: { translations: true },
        });
    }
    async updateBlock(id, dto) {
        const { translations, ...data } = dto;
        if (translations) {
            await this.prisma.pageBlockTranslation.deleteMany({ where: { block_id: id } });
        }
        return this.prisma.pageBlock.update({
            where: { id },
            data: {
                ...data,
                ...(translations && { translations: { create: translations } }),
            },
            include: { translations: true },
        });
    }
    async deleteBlock(id) {
        return this.prisma.pageBlock.delete({ where: { id } });
    }
    async reorderBlocks(pageId, blockIds) {
        const updates = blockIds.map((id, index) => this.prisma.pageBlock.update({
            where: { id },
            data: { sort_order: index },
        }));
        await Promise.all(updates);
        return this.getBlocks(pageId);
    }
};
exports.PageBuilderService = PageBuilderService;
exports.PageBuilderService = PageBuilderService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], PageBuilderService);
//# sourceMappingURL=page-builder.service.js.map