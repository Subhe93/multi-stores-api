import {
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProductDto, UpdateProductDto } from './dto/product.dto';
import { UserRole, ProductStatus } from '@prisma/client';

@Injectable()
export class ProductsService {
  constructor(private prisma: PrismaService) {}

  private readonly productIncludes = {
    translations: true,
    images: { orderBy: { sort_order: 'asc' as const } },
    attributes: {
      include: { template: { include: { translations: true } } },
    },
    variants: true,
    tags: true,
    custom_fields: { include: { translations: true }, orderBy: { sort_order: 'asc' as const } },
    faqs: { include: { translations: true }, orderBy: { sort_order: 'asc' as const } },
    category: { include: { translations: true } },
    shipping_profile: { include: { zones: true } },
  };

  async create(userId: string, userRole: UserRole, dto: CreateProductDto) {
    const { translations, attributes, tags, ...data } = dto;

    const productData: any = {
      ...data,
      translations: { create: translations },
    };

    // ربط المنتج بالـ Provider أو Creator
    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      if (!provider) throw new NotFoundException('Provider profile not found');
      productData.provider_id = provider.id;
    } else if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (!creator) throw new NotFoundException('Creator profile not found');
      productData.creator_id = creator.id;
    }

    // إنشاء المنتج
    const product = await this.prisma.product.create({
      data: productData,
      include: this.productIncludes,
    });

    // إضافة الـ attributes
    if (attributes?.length) {
      await this.prisma.productAttribute.createMany({
        data: attributes.map((attr) => ({
          product_id: product.id,
          template_id: attr.template_id,
          value: attr.value,
        })),
      });
    }

    // إضافة الـ tags
    if (tags?.length) {
      await this.prisma.productTag.createMany({
        data: tags.map((tag) => ({
          product_id: product.id,
          tag,
        })),
      });
    }

    return this.findById(product.id);
  }

  async findAll(filters: {
    page?: number;
    limit?: number;
    category_id?: string;
    product_type?: string;
    status?: ProductStatus;
    provider_id?: string;
    creator_id?: string;
    search?: string;
    is_featured?: boolean;
  }) {
    const { page = 1, limit = 20, ...rest } = filters;
    const skip = (page - 1) * limit;
    const where: any = {};

    if (rest.category_id) where.category_id = rest.category_id;
    if (rest.product_type) where.product_type = rest.product_type;
    if (rest.status) where.status = rest.status;
    if (rest.provider_id) where.provider_id = rest.provider_id;
    if (rest.creator_id) where.creator_id = rest.creator_id;
    if (rest.is_featured !== undefined) where.is_featured = rest.is_featured;
    if (rest.search) {
      where.translations = {
        some: {
          title: { contains: rest.search, mode: 'insensitive' },
        },
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.product.findMany({
        skip,
        take: limit,
        where,
        include: {
          translations: true,
          images: { take: 1, orderBy: { sort_order: 'asc' } },
          category: { include: { translations: true } },
          variants: true,
          provider: { select: { id: true, company_name: true } },
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.product.count({ where }),
    ]);

    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async findById(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: this.productIncludes,
    });

    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async update(
    id: string,
    userId: string,
    userRole: UserRole,
    dto: UpdateProductDto,
  ) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');

    // التحقق من الملكية
    await this.checkOwnership(product, userId, userRole);

    const { translations, attributes, tags, ...data } = dto;

    // تحديث المنتج
    await this.prisma.product.update({
      where: { id },
      data,
    });

    // تحديث الترجمات
    if (translations) {
      await this.prisma.productTranslation.deleteMany({
        where: { product_id: id },
      });
      await this.prisma.productTranslation.createMany({
        data: translations.map((t) => ({ ...t, product_id: id })),
      });
    }

    // تحديث الـ attributes
    if (attributes) {
      await this.prisma.productAttribute.deleteMany({
        where: { product_id: id },
      });
      await this.prisma.productAttribute.createMany({
        data: attributes.map((attr) => ({
          product_id: id,
          template_id: attr.template_id,
          value: attr.value,
        })),
      });
    }

    // تحديث الـ tags
    if (tags) {
      await this.prisma.productTag.deleteMany({
        where: { product_id: id },
      });
      await this.prisma.productTag.createMany({
        data: tags.map((tag) => ({ product_id: id, tag })),
      });
    }

    return this.findById(id);
  }

  async delete(id: string, userId: string, userRole: UserRole) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');

    await this.checkOwnership(product, userId, userRole);

    return this.prisma.product.delete({ where: { id } });
  }

  async updateStatus(
    id: string,
    status: ProductStatus,
    userId: string,
    userRole: UserRole,
  ) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product) throw new NotFoundException('Product not found');

    await this.checkOwnership(product, userId, userRole);

    return this.prisma.product.update({
      where: { id },
      data: { status },
    });
  }

  // Image management
  async addImage(productId: string, url: string, altText?: string, sortOrder?: number, isFeatured?: boolean, variantId?: string) {
    // If setting as featured, unset others
    if (isFeatured) {
      await this.prisma.productImage.updateMany({
        where: { product_id: productId },
        data: { is_featured: false },
      });
    }
    return this.prisma.productImage.create({
      data: { product_id: productId, url, alt_text: altText, sort_order: sortOrder ?? 0, is_featured: isFeatured ?? false, variant_id: variantId },
    });
  }

  async getImages(productId: string) {
    return this.prisma.productImage.findMany({
      where: { product_id: productId },
      orderBy: { sort_order: 'asc' },
    });
  }

  async deleteImage(imageId: string) {
    return this.prisma.productImage.delete({ where: { id: imageId } });
  }

  async reorderImages(productId: string, imageIds: string[]) {
    const updates = imageIds.map((id, i) =>
      this.prisma.productImage.update({ where: { id }, data: { sort_order: i } }),
    );
    await Promise.all(updates);
    return this.getImages(productId);
  }

  async getImportDetails(id: string) {
    const product = await this.prisma.product.findUnique({
      where: { id },
      include: {
        translations: true,
        images: { orderBy: { sort_order: 'asc' } },
        attributes: {
          include: { template: { include: { translations: true } } },
        },
        variants: { where: { is_active: true }, include: { images: true } },
        tags: true,
        custom_fields: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
        faqs: {
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
        category: { include: { translations: true } },
        provider: { select: { id: true, company_name: true } },
        shipping_profile: { include: { zones: true } },
      },
    });

    if (!product) throw new NotFoundException('Product not found');

    // Fallback to provider's default shipping profile if none assigned
    if (!(product as any).shipping_profile && product.provider_id) {
      const defaultProfile = await this.prisma.shippingProfile.findFirst({
        where: { provider_id: product.provider_id, is_default: true },
        include: { zones: true },
      });
      if (defaultProfile) {
        return { ...product, shipping_profile: defaultProfile };
      }
    }

    return product;
  }

  private async checkOwnership(
    product: any,
    userId: string,
    userRole: UserRole,
  ) {
    if (userRole === UserRole.ADMIN) return;

    if (userRole === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: userId },
      });
      if (product.provider_id !== provider?.id) {
        throw new ForbiddenException('Not your product');
      }
    }

    if (userRole === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: userId },
      });
      if (product.creator_id !== creator?.id) {
        throw new ForbiddenException('Not your product');
      }
    }
  }
}
