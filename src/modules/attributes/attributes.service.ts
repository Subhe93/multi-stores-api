import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateAttributeTemplateDto,
  UpdateAttributeTemplateDto,
} from './dto/attribute.dto';

@Injectable()
export class AttributesService {
  constructor(private prisma: PrismaService) {}

  async create(dto: CreateAttributeTemplateDto) {
    const { translations, ...data } = dto;

    return this.prisma.attributeTemplate.create({
      data: {
        ...data,
        ...(translations && {
          translations: { create: translations },
        }),
      },
      include: { translations: true },
    });
  }

  async findAll() {
    return this.prisma.attributeTemplate.findMany({
      include: { translations: true },
      orderBy: { sort_order: 'asc' },
    });
  }

  async findById(id: string) {
    const template = await this.prisma.attributeTemplate.findUnique({
      where: { id },
      include: { translations: true },
    });

    if (!template) throw new NotFoundException('Attribute template not found');
    return template;
  }

  async update(id: string, dto: UpdateAttributeTemplateDto) {
    const { translations, ...data } = dto;

    if (translations) {
      await this.prisma.attributeTemplateTranslation.deleteMany({
        where: { template_id: id },
      });
    }

    return this.prisma.attributeTemplate.update({
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
    return this.prisma.attributeTemplate.delete({ where: { id } });
  }
}
