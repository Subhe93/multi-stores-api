import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePageDto, UpdatePageDto } from './dto/page.dto';

@Injectable()
export class PagesService {
  constructor(private prisma: PrismaService) {}

  async findByStore(storeId: string) {
    return this.prisma.staticPage.findMany({
      where: { store_id: storeId },
      include: { translations: true, blocks: { include: { translations: true }, orderBy: { sort_order: 'asc' } } },
      orderBy: { sort_order: 'asc' },
    });
  }

  async findById(id: string) {
    const page = await this.prisma.staticPage.findUnique({
      where: { id },
      include: { translations: true, blocks: { include: { translations: true }, orderBy: { sort_order: 'asc' } } },
    });
    if (!page) throw new NotFoundException({ code: 'PAGE_LEGACY_NOT_FOUND', message: 'Page not found' });
    return page;
  }

  async create(storeId: string, dto: CreatePageDto) {
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

  async update(id: string, dto: UpdatePageDto) {
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

  async delete(id: string) {
    const page = await this.prisma.staticPage.findUnique({ where: { id } });
    if (!page) throw new NotFoundException({ code: 'PAGE_LEGACY_NOT_FOUND', message: 'Page not found' });
    if (page.is_required) throw new NotFoundException({ code: 'PAGE_LEGACY_CANNOT_DELETE_REQUIRED', message: 'Cannot delete required page' });

    return this.prisma.staticPage.delete({ where: { id } });
  }
}
