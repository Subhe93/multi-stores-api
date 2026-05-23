import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCategoryDto,
  UpdateCategoryDto,
  LinkAttributesDto,
} from './dto/category.dto';

@Injectable()
export class CategoriesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateCategoryDto) {
    const { translations, ...data } = dto;

    return this.prisma.category.create({
      data: {
        ...data,
        translations: {
          create: translations,
        },
      },
      include: { translations: true },
    });
  }

  async findAll() {
    return this.prisma.category.findMany({
      where: { parent_id: null },
      include: {
        translations: true,
        children: {
          include: {
            translations: true,
            children: {
              include: { translations: true },
            },
          },
        },
      },
      orderBy: { sort_order: 'asc' },
    });
  }

  async findById(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        translations: true,
        children: { include: { translations: true } },
        attribute_templates: {
          include: {
            template: { include: { translations: true } },
          },
        },
      },
    });

    if (!category) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Category not found' });
    return category;
  }

  async findBySlug(slug: string) {
    const category = await this.prisma.category.findUnique({
      where: { slug },
      include: {
        translations: true,
        children: { include: { translations: true } },
        attribute_templates: {
          include: {
            template: { include: { translations: true } },
          },
        },
      },
    });

    if (!category) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Category not found' });
    return category;
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const { translations, ...data } = dto;

    if (translations) {
      // حذف الترجمات القديمة وإنشاء الجديدة
      await this.prisma.categoryTranslation.deleteMany({
        where: { category_id: id },
      });
    }

    return this.prisma.category.update({
      where: { id },
      data: {
        ...data,
        ...(translations && {
          translations: { create: translations },
        }),
      },
      include: { translations: true },
    });
  }

  async delete(id: string) {
    return this.prisma.category.delete({ where: { id } });
  }

  async getAttributeTemplates(id: string) {
    const category = await this.prisma.category.findUnique({
      where: { id },
      include: {
        attribute_templates: {
          include: {
            template: { include: { translations: true } },
          },
          orderBy: { template: { sort_order: 'asc' } },
        },
      },
    });

    if (!category) throw new NotFoundException({ code: 'CATEGORY_NOT_FOUND', message: 'Category not found' });
    return category.attribute_templates.map((cat) => cat.template);
  }

  async linkAttributes(id: string, dto: LinkAttributesDto) {
    // حذف الروابط القديمة
    await this.prisma.categoryAttributeTemplate.deleteMany({
      where: { category_id: id },
    });

    // إنشاء روابط جديدة
    await this.prisma.categoryAttributeTemplate.createMany({
      data: dto.template_ids.map((template_id) => ({
        category_id: id,
        template_id,
      })),
    });

    return this.getAttributeTemplates(id);
  }
}
