import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';

@Injectable()
export class VariantsService {
  constructor(private prisma: PrismaService) {}

  async create(productId: string, dto: CreateVariantDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException({ code: 'VARIANT_PRODUCT_NOT_FOUND', message: 'Product not found' });

    return this.prisma.productVariant.create({
      data: {
        product_id: productId,
        ...dto,
      },
      include: { images: true },
    });
  }

  async findByProduct(productId: string) {
    return this.prisma.productVariant.findMany({
      where: { product_id: productId },
      include: { images: true },
      orderBy: { sku: 'asc' },
    });
  }

  async findById(id: string) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id },
      include: { images: true },
    });

    if (!variant) throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Variant not found' });
    return variant;
  }

  async update(id: string, dto: UpdateVariantDto) {
    return this.prisma.productVariant.update({
      where: { id },
      data: dto,
      include: { images: true },
    });
  }

  async delete(id: string) {
    return this.prisma.productVariant.delete({ where: { id } });
  }

  async updateStock(id: string, quantity: number) {
    return this.prisma.productVariant.update({
      where: { id },
      data: { stock_quantity: quantity },
    });
  }
}
