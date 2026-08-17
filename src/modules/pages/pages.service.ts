import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { CreatePageDto, UpdatePageDto } from './dto/page.dto';

@Injectable()
export class PagesService {
  constructor(private prisma: PrismaService) {}

  async findByStore(storeId: string, userId: string, userRole: UserRole) {
    await this.assertOwnsStore(storeId, userId, userRole);
    return this.prisma.staticPage.findMany({
      where: { store_id: storeId },
      include: { translations: true, blocks: { include: { translations: true }, orderBy: { sort_order: 'asc' } } },
      orderBy: { sort_order: 'asc' },
    });
  }

  async findById(id: string, userId: string, userRole: UserRole) {
    const page = await this.prisma.staticPage.findUnique({
      where: { id },
      include: { translations: true, blocks: { include: { translations: true }, orderBy: { sort_order: 'asc' } } },
    });
    if (!page) throw new NotFoundException({ code: 'PAGE_LEGACY_NOT_FOUND', message: 'Page not found' });
    await this.assertOwnsStore(page.store_id, userId, userRole);
    return page;
  }

  async create(
    storeId: string,
    dto: CreatePageDto,
    userId: string,
    userRole: UserRole,
  ) {
    await this.assertOwnsStore(storeId, userId, userRole);
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

  async update(
    id: string,
    dto: UpdatePageDto,
    userId: string,
    userRole: UserRole,
  ) {
    await this.assertOwnsPage(id, userId, userRole);
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

  async delete(id: string, userId: string, userRole: UserRole) {
    const page = await this.prisma.staticPage.findUnique({ where: { id } });
    if (!page) throw new NotFoundException({ code: 'PAGE_LEGACY_NOT_FOUND', message: 'Page not found' });
    await this.assertOwnsStore(page.store_id, userId, userRole);
    if (page.is_required) throw new NotFoundException({ code: 'PAGE_LEGACY_CANNOT_DELETE_REQUIRED', message: 'Cannot delete required page' });

    return this.prisma.staticPage.delete({ where: { id } });
  }

  /**
   * These pages render on the public storefront through dangerouslySetInnerHTML,
   * so an unchecked store id let any creator deface another store and plant
   * script that runs for every visitor on that origin.
   */
  private async assertOwnsPage(pageId: string, userId: string, userRole: UserRole) {
    const page = await this.prisma.staticPage.findUnique({
      where: { id: pageId },
      select: { store_id: true },
    });
    if (!page) throw new NotFoundException({ code: 'PAGE_LEGACY_NOT_FOUND', message: 'Page not found' });
    await this.assertOwnsStore(page.store_id, userId, userRole);
  }

  private async assertOwnsStore(storeId: string, userId: string, userRole: UserRole) {
    if (userRole === UserRole.ADMIN) return;

    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    const store = creator
      ? await this.prisma.store.findUnique({
          where: { id: storeId },
          select: { creator_id: true },
        })
      : null;

    if (!creator || !store || store.creator_id !== creator.id) {
      throw new ForbiddenException({
        code: 'PAGE_LEGACY_FORBIDDEN',
        message: 'This page belongs to another store',
      });
    }
  }
}
