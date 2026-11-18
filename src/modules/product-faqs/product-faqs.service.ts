import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
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

/** The caller of a write route (from the JWT). */
export interface FaqActor {
  id: string;
  role: UserRole;
}

/** What the storefront cache refresh needs to know about a product. */
interface FaqProduct {
  id: string;
  provider_id: string | null;
  creator_id: string | null;
}

const FORBIDDEN = {
  code: 'PRODUCT_FAQ_FORBIDDEN',
  message: 'Not your product',
};

@Injectable()
export class ProductFaqsService {
  constructor(
    private prisma: PrismaService,
    // Storefront cache refresh; optional for positional tests.
    @Optional() private readonly revalidation?: RevalidationService,
  ) {}

  async create(productId: string, dto: CreateProductFaqDto, actor: FaqActor) {
    const product = await this.assertOwnsProduct(productId, actor);
    const created = await this.prisma.productFaq.create({
      data: {
        product_id: productId,
        sort_order: dto.sort_order ?? 0,
        translations: { create: dto.translations.map(sanitizeFaqTranslation) },
      },
      include: { translations: true },
    });
    await this.revalidation?.revalidateStoresOfProduct(product);
    return created;
  }

  async findByProduct(productId: string) {
    return this.prisma.productFaq.findMany({
      where: { product_id: productId },
      include: { translations: true },
      orderBy: { sort_order: 'asc' },
    });
  }

  async update(id: string, dto: UpdateProductFaqDto, actor: FaqActor) {
    const product = await this.assertOwnsFaq(id, actor);

    if (dto.translations && dto.translations.length > 0) {
      await this.prisma.productFaqTranslation.deleteMany({
        where: { faq_id: id },
      });
    }

    const updated = await this.prisma.productFaq.update({
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
    await this.revalidation?.revalidateStoresOfProduct(product);
    return updated;
  }

  async delete(id: string, actor: FaqActor) {
    const product = await this.assertOwnsFaq(id, actor);
    const deleted = await this.prisma.productFaq.delete({ where: { id } });
    await this.revalidation?.revalidateStoresOfProduct(product);
    return deleted;
  }

  async reorder(productId: string, faqIds: string[], actor: FaqActor) {
    const product = await this.assertOwnsProduct(productId, actor);
    // Scoped to the product: ids of another product's FAQs match nothing.
    await Promise.all(
      (faqIds ?? []).map((id, i) =>
        this.prisma.productFaq.updateMany({
          where: { id, product_id: productId },
          data: { sort_order: i },
        }),
      ),
    );
    await this.revalidation?.revalidateStoresOfProduct(product);
    return this.findByProduct(productId);
  }

  private async assertOwnsFaq(
    id: string,
    actor: FaqActor,
  ): Promise<FaqProduct> {
    const faq = await this.prisma.productFaq.findUnique({
      where: { id },
      select: { product_id: true },
    });
    if (!faq)
      throw new NotFoundException({
        code: 'PRODUCT_FAQ_NOT_FOUND',
        message: 'FAQ not found',
      });
    return this.assertOwnsProduct(faq.product_id, actor);
  }

  /**
   * ADMIN may edit any product's FAQs; a PROVIDER or CREATOR only those of a
   * product they own. A missing product answers 404 to everyone.
   */
  private async assertOwnsProduct(
    productId: string,
    actor: FaqActor,
  ): Promise<FaqProduct> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { id: true, provider_id: true, creator_id: true },
    });
    if (!product)
      throw new NotFoundException({
        code: 'PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
    if (actor.role === UserRole.ADMIN) return product;

    if (actor.role === UserRole.PROVIDER) {
      const provider = await this.prisma.provider.findUnique({
        where: { user_id: actor.id },
        select: { id: true },
      });
      if (provider && product.provider_id === provider.id) return product;
      throw new ForbiddenException(FORBIDDEN);
    }

    if (actor.role === UserRole.CREATOR) {
      const creator = await this.prisma.creator.findUnique({
        where: { user_id: actor.id },
        select: { id: true },
      });
      if (creator && product.creator_id === creator.id) return product;
    }
    throw new ForbiddenException(FORBIDDEN);
  }
}
