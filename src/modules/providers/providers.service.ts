import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateProviderDto, UpdateProviderDto } from './dto/create-provider.dto';

@Injectable()
export class ProvidersService {
  constructor(private prisma: PrismaService) {}

  async create(userId: string, dto: CreateProviderDto) {
    return this.prisma.provider.create({
      data: {
        user_id: userId,
        ...dto,
      },
    });
  }

  async findByUserId(userId: string) {
    const provider = await this.prisma.provider.findUnique({
      where: { user_id: userId },
    });
    if (!provider) throw new NotFoundException({ code: 'PROVIDER_PROFILE_NOT_FOUND', message: 'Provider profile not found' });
    return provider;
  }

  async findById(id: string) {
    const provider = await this.prisma.provider.findUnique({
      where: { id },
      include: { user: { select: { email: true, status: true } } },
    });
    if (!provider) throw new NotFoundException({ code: 'PROVIDER_NOT_FOUND', message: 'Provider not found' });
    return provider;
  }

  async update(userId: string, dto: UpdateProviderDto) {
    return this.prisma.provider.update({
      where: { user_id: userId },
      data: dto,
    });
  }

  async findAll(page = 1, limit = 20) {
    const skip = (page - 1) * limit;
    const [data, total] = await Promise.all([
      this.prisma.provider.findMany({
        skip,
        take: limit,
        include: { user: { select: { email: true, status: true } } },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.provider.count(),
    ]);
    return {
      data,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async verify(id: string) {
    return this.prisma.provider.update({
      where: { id },
      data: { verified: true },
    });
  }

  /** List stores that use products from this provider (via custom products). */
  async findStoresUsingProvider(userId: string, page = 1, limit = 20) {
    const provider = await this.prisma.provider.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!provider) throw new NotFoundException({ code: 'PROVIDER_PROFILE_NOT_FOUND', message: 'Provider profile not found' });

    const skip = (page - 1) * limit;

    const baseWhere = {
      creator: {
        custom_products: {
          some: { product: { provider_id: provider.id } },
        },
      },
    };

    const [stores, total] = await Promise.all([
      this.prisma.store.findMany({
        where: baseWhere,
        skip,
        take: limit,
        include: {
          creator: { select: { display_name: true, avatar_url: true, verified: true } },
          language_config: { select: { primary_locale: true } },
          _count: { select: { static_pages: true } },
        },
        orderBy: { created_at: 'desc' },
      }),
      this.prisma.store.count({ where: baseWhere }),
    ]);

    const storesWithCounts = await Promise.all(
      stores.map(async (s) => {
        const productsCount = await this.prisma.customProduct.count({
          where: {
            creator_id: s.creator_id,
            product: { provider_id: provider.id },
          },
        });
        return { ...s, products_using_count: productsCount };
      }),
    );

    return {
      data: storesWithCounts,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  /** Public store details — accessible only if the store uses this provider's products. */
  async findStoreForProvider(userId: string, storeId: string) {
    const provider = await this.prisma.provider.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!provider) throw new NotFoundException({ code: 'PROVIDER_PROFILE_NOT_FOUND', message: 'Provider profile not found' });

    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      include: {
        creator: {
          select: {
            display_name: true,
            avatar_url: true,
            cover_url: true,
            bio: true,
            verified: true,
          },
        },
        language_config: true,
        static_pages: {
          where: { status: 'PUBLISHED' },
          include: { translations: true },
          orderBy: { sort_order: 'asc' },
        },
      },
    });
    if (!store) throw new NotFoundException({ code: 'PROVIDER_STORE_NOT_FOUND', message: 'Store not found' });

    const usesProvider = await this.prisma.customProduct.findFirst({
      where: {
        creator_id: store.creator_id,
        product: { provider_id: provider.id },
      },
      select: { id: true },
    });
    if (!usesProvider) {
      throw new NotFoundException({ code: 'PROVIDER_STORE_NOT_USING_PRODUCTS', message: 'Store does not use your products' });
    }

    const customProducts = await this.prisma.customProduct.findMany({
      where: {
        creator_id: store.creator_id,
        product: { provider_id: provider.id },
      },
      include: {
        translations: true,
        mockup_images: { orderBy: { sort_order: 'asc' }, take: 1 },
        selected_variants: {
          select: {
            custom_price: true,
            variant: { select: { price_adjustment: true } },
          },
        },
        product: {
          include: {
            translations: true,
            images: { orderBy: { sort_order: 'asc' }, take: 1 },
          },
        },
      },
      orderBy: { created_at: 'desc' },
      take: 50,
    });

    return { ...store, custom_products_using: customProducts };
  }
}
