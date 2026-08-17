import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';

@Injectable()
export class VariantsService {
  constructor(private prisma: PrismaService) {}

  async create(
    productId: string,
    dto: CreateVariantDto,
    userId: string,
    userRole: UserRole,
  ) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException({ code: 'VARIANT_PRODUCT_NOT_FOUND', message: 'Product not found' });
    await this.assertOwnsProduct(product, userId, userRole);

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

  async update(
    id: string,
    dto: UpdateVariantDto,
    userId: string,
    userRole: UserRole,
  ) {
    await this.assertOwnsVariant(id, userId, userRole);
    return this.prisma.productVariant.update({
      where: { id },
      data: dto,
      include: { images: true },
    });
  }

  async delete(id: string, userId: string, userRole: UserRole) {
    await this.assertOwnsVariant(id, userId, userRole);
    return this.prisma.productVariant.delete({ where: { id } });
  }

  async updateStock(
    id: string,
    quantity: number,
    userId: string,
    userRole: UserRole,
  ) {
    await this.assertOwnsVariant(id, userId, userRole);
    return this.prisma.productVariant.update({
      where: { id },
      data: { stock_quantity: quantity },
    });
  }

  /**
   * Resolve a variant's owning product and assert the caller owns it. Without
   * this a bare variant id was enough for any seller to reprice, restock or
   * delete a competitor's variants.
   */
  private async assertOwnsVariant(
    variantId: string,
    userId: string,
    userRole: UserRole,
  ) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id: variantId },
      select: { product: { select: { provider_id: true, creator_id: true } } },
    });
    if (!variant) throw new NotFoundException({ code: 'VARIANT_NOT_FOUND', message: 'Variant not found' });
    await this.assertOwnsProduct(variant.product, userId, userRole);
  }

  private async assertOwnsProduct(
    product: { provider_id: string | null; creator_id: string | null },
    userId: string,
    userRole: UserRole,
  ) {
    if (userRole === UserRole.ADMIN) return;

    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      if (!provider || product.provider_id !== provider.id) {
        throw new ForbiddenException({ code: 'VARIANT_FORBIDDEN', message: 'Not your product' });
      }
      return;
    }

    if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator || product.creator_id !== creator.id) {
        throw new ForbiddenException({ code: 'VARIANT_FORBIDDEN', message: 'Not your product' });
      }
      return;
    }

    throw new ForbiddenException({ code: 'VARIANT_FORBIDDEN', message: 'Not your product' });
  }
}
