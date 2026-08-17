import { Injectable, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '@prisma/client';
import { CreateBlockDto, UpdateBlockDto } from './dto/block.dto';

@Injectable()
export class PageBuilderService {
  constructor(private prisma: PrismaService) {}

  async getBlocks(pageId: string, userId: string, userRole: UserRole) {
    await this.assertOwnsPage(pageId, userId, userRole);
    return this.prisma.pageBlock.findMany({
      where: { page_id: pageId },
      include: { translations: true },
      orderBy: { sort_order: 'asc' },
    });
  }

  async addBlock(
    pageId: string,
    dto: CreateBlockDto,
    userId: string,
    userRole: UserRole,
  ) {
    await this.assertOwnsPage(pageId, userId, userRole);

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

  async updateBlock(
    id: string,
    dto: UpdateBlockDto,
    userId: string,
    userRole: UserRole,
  ) {
    await this.assertOwnsBlock(id, userId, userRole);
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

  async deleteBlock(id: string, userId: string, userRole: UserRole) {
    await this.assertOwnsBlock(id, userId, userRole);
    return this.prisma.pageBlock.delete({ where: { id } });
  }

  async reorderBlocks(
    pageId: string,
    blockIds: string[],
    userId: string,
    userRole: UserRole,
  ) {
    await this.assertOwnsPage(pageId, userId, userRole);

    // Only reorder blocks that actually live on this page, so a foreign block
    // id in the list can't be dragged into someone else's ordering.
    const owned = await this.prisma.pageBlock.findMany({
      where: { page_id: pageId, id: { in: blockIds } },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((b) => b.id));

    await Promise.all(
      blockIds
        .filter((id) => ownedIds.has(id))
        .map((id, index) =>
          this.prisma.pageBlock.update({
            where: { id },
            data: { sort_order: index },
          }),
        ),
    );
    return this.getBlocks(pageId, userId, userRole);
  }

  /**
   * Block content (including raw_html) renders on the public storefront, so an
   * unchecked block or page id was a cross-tenant stored-XSS vector.
   */
  private async assertOwnsBlock(blockId: string, userId: string, userRole: UserRole) {
    const block = await this.prisma.pageBlock.findUnique({
      where: { id: blockId },
      select: { page: { select: { store_id: true } } },
    });
    if (!block) throw new NotFoundException({ code: 'PAGE_BUILDER_BLOCK_NOT_FOUND', message: 'Block not found' });
    await this.assertOwnsStore(block.page.store_id, userId, userRole);
  }

  private async assertOwnsPage(pageId: string, userId: string, userRole: UserRole) {
    const page = await this.prisma.staticPage.findUnique({
      where: { id: pageId },
      select: { store_id: true },
    });
    if (!page) throw new NotFoundException({ code: 'PAGE_BUILDER_PAGE_NOT_FOUND', message: 'Page not found' });
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
        code: 'PAGE_BUILDER_FORBIDDEN',
        message: 'This page belongs to another store',
      });
    }
  }
}
