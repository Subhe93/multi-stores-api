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
exports.CustomFieldsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let CustomFieldsService = class CustomFieldsService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async create(productId, dto) {
        const product = await this.prisma.product.findUnique({
            where: { id: productId },
        });
        if (!product)
            throw new common_1.NotFoundException('Product not found');
        const { translations, ...data } = dto;
        return this.prisma.productCustomField.create({
            data: {
                product_id: productId,
                ...data,
                ...(translations && { translations: { create: translations } }),
            },
            include: { translations: true },
        });
    }
    async findByProduct(productId) {
        return this.prisma.productCustomField.findMany({
            where: { product_id: productId },
            include: { translations: true },
            orderBy: { sort_order: 'asc' },
        });
    }
    async update(id, dto) {
        const { translations, ...data } = dto;
        if (translations) {
            await this.prisma.customFieldTranslation.deleteMany({
                where: { field_id: id },
            });
        }
        return this.prisma.productCustomField.update({
            where: { id },
            data: {
                ...data,
                ...(translations && { translations: { create: translations } }),
            },
            include: { translations: true },
        });
    }
    async delete(id) {
        return this.prisma.productCustomField.delete({ where: { id } });
    }
    async reorder(productId, fieldIds) {
        const updates = fieldIds.map((id, index) => this.prisma.productCustomField.update({
            where: { id },
            data: { sort_order: index },
        }));
        await Promise.all(updates);
        return this.findByProduct(productId);
    }
};
exports.CustomFieldsService = CustomFieldsService;
exports.CustomFieldsService = CustomFieldsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], CustomFieldsService);
//# sourceMappingURL=custom-fields.service.js.map