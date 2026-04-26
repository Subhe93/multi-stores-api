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
exports.VariantsService = void 0;
const common_1 = require("@nestjs/common");
const prisma_service_1 = require("../../prisma/prisma.service");
let VariantsService = class VariantsService {
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
        return this.prisma.productVariant.create({
            data: {
                product_id: productId,
                ...dto,
            },
            include: { images: true },
        });
    }
    async findByProduct(productId) {
        return this.prisma.productVariant.findMany({
            where: { product_id: productId },
            include: { images: true },
            orderBy: { sku: 'asc' },
        });
    }
    async findById(id) {
        const variant = await this.prisma.productVariant.findUnique({
            where: { id },
            include: { images: true },
        });
        if (!variant)
            throw new common_1.NotFoundException('Variant not found');
        return variant;
    }
    async update(id, dto) {
        return this.prisma.productVariant.update({
            where: { id },
            data: dto,
            include: { images: true },
        });
    }
    async delete(id) {
        return this.prisma.productVariant.delete({ where: { id } });
    }
    async updateStock(id, quantity) {
        return this.prisma.productVariant.update({
            where: { id },
            data: { stock_quantity: quantity },
        });
    }
};
exports.VariantsService = VariantsService;
exports.VariantsService = VariantsService = __decorate([
    (0, common_1.Injectable)(),
    __metadata("design:paramtypes", [prisma_service_1.PrismaService])
], VariantsService);
//# sourceMappingURL=variants.service.js.map