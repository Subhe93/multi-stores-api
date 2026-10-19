import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateProductFaqDto,
  FaqTranslationDto,
  UpdateProductFaqDto,
} from './dto/product-faq.dto';
import { sanitizeCreatorHtml } from '../../common/html/creator-html';

/** The answer is rendered as HTML on the storefront; the question is text. */
function sanitizeFaqTranslation(t: FaqTranslationDto): FaqTranslationDto {
  return { ...t, answer: sanitizeCreatorHtml(t.answer) ?? '' };
}

@Injectable()
export class ProductFaqsService {
  constructor(private prisma: PrismaService) {}

  async create(productId: string, dto: CreateProductFaqDto) {
    return this.prisma.productFaq.create({
      data: {
        product_id: productId,
        sort_order: dto.sort_order ?? 0,
        translations: { create: dto.translations.map(sanitizeFaqTranslation) },
      },
      include: { translations: true },
    });
  }

  async findByProduct(productId: string) {
    return this.prisma.productFaq.findMany({
      where: { product_id: productId },
      include: { translations: true },
      orderBy: { sort_order: 'asc' },
    });
  }

  async update(id: string, dto: UpdateProductFaqDto) {
    const faq = await this.prisma.productFaq.findUnique({ where: { id } });
    if (!faq)
      throw new NotFoundException({
        code: 'PRODUCT_FAQ_NOT_FOUND',
        message: 'FAQ not found',
      });

    if (dto.translations && dto.translations.length > 0) {
      await this.prisma.productFaqTranslation.deleteMany({
        where: { faq_id: id },
      });
    }

    return this.prisma.productFaq.update({
      where: { id },
      data: {
        ...(dto.sort_order !== undefined && { sort_order: dto.sort_order }),
        ...(dto.translations &&
          dto.translations.length > 0 && {
            translations: {
              create: dto.translations.map(sanitizeFaqTranslation),
            },
          }),
      },
      include: { translations: true },
    });
  }

  async delete(id: string) {
    return this.prisma.productFaq.delete({ where: { id } });
  }

  async reorder(productId: string, faqIds: string[]) {
    const updates = faqIds.map((id, i) =>
      this.prisma.productFaq.update({ where: { id }, data: { sort_order: i } }),
    );
    await Promise.all(updates);
    return this.findByProduct(productId);
  }
}
