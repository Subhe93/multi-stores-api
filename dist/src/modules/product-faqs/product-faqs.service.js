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
exports.ProductFaqsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let ProductFaqsService = class ProductFaqsService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(productId, dto) {
        return this.prisma.productFaq.create({
            data: {
                product_id: productId,
                sort_order: dto.sort_order ?? 0,
                translations: { create: dto.translations },
            },
            include: { translations: true },
        });
    }
    async findByProduct(productId) {
        return this.prisma.productFaq.findMany({
            where: { product_id: productId },
            include: { translations: true },
            orderBy: { sort_order: 'asc' },
        });
    }
    async update(id, dto) {
        const faq = await this.prisma.productFaq.findUnique({ where: { id } });
        if (!faq)
            throw new common_1.NotFoundException('FAQ not found');
        if (dto.translations && dto.translations.length > 0) {
            await this.prisma.productFaqTranslation.deleteMany({
                where: { faq_id: id },
            });
        }
        return this.prisma.productFaq.update({
            where: { id },
            data: {
                ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
                ...(dto.translations &&
                    dto.translations.length > 0 && {
                    translations: { create: dto.translations },
                }),
            },
            include: { translations: true },
        });
    }
    async delete(id) {
        return this.prisma.productFaq.delete({ where: { id } });
    }
    async reorder(productId, faqIds) {
        const updates = faqIds.map((id, i) => this.prisma.productFaq.update({ where: { id }, data: { sort_order: i } }));
        await Promise.all(updates);
        return this.findByProduct(productId);
    }
};
exports.ProductFaqsService = ProductFaqsService;
exports.ProductFaqsService = ProductFaqsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], ProductFaqsService);
//# sourceMappingURL=product-faqs.service.js.map