import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateBlockDto, UpdateBlockDto } from './dto/block.dto';

@Injectable()
export class PageBuilderService {
  constructor(private prisma: PrismaService) {}

  async getBlocks(pageId: string) {
    return this.prisma.pageBlock.findMany({
      where: { page_id: pageId },
      include: { translations: true },
      orderBy: { sort_order: 'asc' },
    });
  }

  async addBlock(pageId: string, dto: CreateBlockDto) {
    const page = await this.prisma.staticPage.findUnique({ where: { id: pageId } });
    if (!page) throw new NotFoundException('Page not found');

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

  async updateBlock(id: string, dto: UpdateBlockDto) {
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

  async deleteBlock(id: string) {
    return this.prisma.pageBlock.delete({ where: { id } });
  }

  async reorderBlocks(pageId: string, blockIds: string[]) {
    const updates = blockIds.map((id, index) =>
      this.prisma.pageBlock.update({
        where: { id },
        data: { sort_order: index },
      }),
    );
    await Promise.all(updates);
    return this.getBlocks(pageId);
  }
}
