import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateCustomFieldDto, UpdateCustomFieldDto } from './dto/custom-field.dto';

@Injectable()
export class CustomFieldsService {
  constructor(private prisma: PrismaService) {}

  async create(productId: string, dto: CreateCustomFieldDto) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
    });
    if (!product) throw new NotFoundException({ code: 'CUSTOM_FIELD_PRODUCT_NOT_FOUND', message: 'Product not found' });

    const { translations, ...data } = dto;

    return this.prisma.productCustomField.create({
      data: {
        product_id: productId,
        ...data,
        ...(translations && { translations: { create: translations } }),
      },
      include: { translations: true },
    });
  }

  async findByProduct(productId: string) {
    return this.prisma.productCustomField.findMany({
      where: { product_id: productId },
      include: { translations: true },
      orderBy: { sort_order: 'asc' },
    });
  }

  async update(id: string, dto: UpdateCustomFieldDto) {
    const { translations, ...data } = dto;

    if (translations) {
      await this.prisma.customFieldTranslation.deleteMany({
        where: { field_id: id },
      });
    }

    return this.prisma.productCustomField.update({
      where: { id },
      data: {
        ...data,
        ...(translations && { translations: { create: translations } }),
      },
      include: { translations: true },
    });
  }

  async delete(id: string) {
    return this.prisma.productCustomField.delete({ where: { id } });
  }

  async reorder(productId: string, fieldIds: string[]) {
    // Update sort_order based on array position
    const updates = fieldIds.map((id, index) =>
      this.prisma.productCustomField.update({
        where: { id },
        data: { sort_order: index },
      }),
    );
    await Promise.all(updates);

    return this.findByProduct(productId);
  }
}
