import {
  Injectable,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { ProductStatus, UserRole } from '@prisma/client';
import { CreateVariantDto, UpdateVariantDto } from './dto/variant.dto';
import {
  catalogueReadLevel,
  loadCatalogueViewer,
} from '../products/catalogue-access';

/** A variant as a non-owner may read it: without the importer identity. */
function withoutImporterRef<T extends { external_ref?: unknown }>(
  v: T,
): Omit<T, 'external_ref'> {
  const { external_ref: _ref, ...rest } = v;
  void _ref;
  return rest;
}

@Injectable()
export class VariantsService {
  constructor(
    private prisma: PrismaService,
    private readonly revalidation: RevalidationService,
  ) {}

  async create(
    productId: string,
    dto: CreateVariantDto,
    userId: string,
    userRole: UserRole,
  ) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product)
      throw new NotFoundException({
        code: 'VARIANT_PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
    await this.assertOwnsProduct(product, userId, userRole);

    const created = await this.prisma.productVariant.create({
      data: {
        product_id: productId,
        ...dto,
      },
      include: { images: true },
    });
    await this.revalidation.revalidateStoresOfProduct(product);
    return created;
  }

  async findByProduct(productId: string, userId: string, userRole: UserRole) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { provider_id: true, creator_id: true, status: true },
    });
    const level = product
      ? await this.readLevel(product, userId, userRole)
      : null;
    if (!level)
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
    const rows = await this.prisma.productVariant.findMany({
      where: { product_id: productId },
      include: { images: true },
      orderBy: { sku: 'asc' },
    });
    return level === 'full' ? rows : rows.map(withoutImporterRef);
  }

  async findById(id: string, userId: string, userRole: UserRole) {
    const variant = await this.prisma.productVariant.findUnique({
      where: { id },
      include: {
        images: true,
        product: {
          select: { provider_id: true, creator_id: true, status: true },
        },
      },
    });
    const level = variant
      ? await this.readLevel(variant.product, userId, userRole)
      : null;
    if (!variant || !level)
      throw new NotFoundException({
        code: 'VARIANT_NOT_FOUND',
        message: 'Variant not found',
      });
    // The product relation was loaded for the check only.
    const { product: _product, ...row } = variant;
    void _product;
    return level === 'full' ? row : withoutImporterRef(row);
  }

  /** catalogueReadLevel of the caller on the variant's product. */
  private async readLevel(
    product: {
      provider_id: string | null;
      creator_id: string | null;
      status: ProductStatus;
    },
    userId: string,
    userRole: UserRole,
  ) {
    return catalogueReadLevel(
      product,
      await loadCatalogueViewer(this.prisma, userId, userRole),
    );
  }

  async update(
    id: string,
    dto: UpdateVariantDto,
    userId: string,
    userRole: UserRole,
  ) {
    const product = await this.assertOwnsVariant(id, userId, userRole);
    const updated = await this.prisma.productVariant.update({
      where: { id },
      data: dto,
      include: { images: true },
    });
    await this.revalidation.revalidateStoresOfProduct(product);
    return updated;
  }

  async delete(id: string, userId: string, userRole: UserRole) {
    const product = await this.assertOwnsVariant(id, userId, userRole);
    const deleted = await this.prisma.productVariant.delete({ where: { id } });
    await this.revalidation.revalidateStoresOfProduct(product);
    return deleted;
  }

  async updateStock(
    id: string,
    quantity: number,
    userId: string,
    userRole: UserRole,
  ) {
    const product = await this.assertOwnsVariant(id, userId, userRole);
    const updated = await this.prisma.productVariant.update({
      where: { id },
      data: { stock_quantity: quantity },
    });
    await this.revalidation.revalidateStoresOfProduct(product);
    return updated;
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
      select: {
        product: { select: { id: true, provider_id: true, creator_id: true } },
      },
    });
    if (!variant)
      throw new NotFoundException({
        code: 'VARIANT_NOT_FOUND',
        message: 'Variant not found',
      });
    await this.assertOwnsProduct(variant.product, userId, userRole);
    return variant.product;
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
        throw new ForbiddenException({
          code: 'VARIANT_FORBIDDEN',
          message: 'Not your product',
        });
      }
      return;
    }

    if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator || product.creator_id !== creator.id) {
        throw new ForbiddenException({
          code: 'VARIANT_FORBIDDEN',
          message: 'Not your product',
        });
      }
      return;
    }

    throw new ForbiddenException({
      code: 'VARIANT_FORBIDDEN',
      message: 'Not your product',
    });
  }
}
