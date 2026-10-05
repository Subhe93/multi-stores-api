import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
} from './dto/custom-field.dto';

@Injectable()
export class CustomFieldsService {
  constructor(private prisma: PrismaService) {}

  async create(
    productId: string,
    dto: CreateCustomFieldDto,
    userId: string,
    role: UserRole,
  ) {
    await this.assertCanManage(productId, userId, role);

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

  async update(
    id: string,
    dto: UpdateCustomFieldDto,
    userId: string,
    role: UserRole,
  ) {
    const field = await this.findFieldOrThrow(id);
    await this.assertCanManage(field.product_id, userId, role);

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

  async delete(id: string, userId: string, role: UserRole) {
    const field = await this.findFieldOrThrow(id);
    await this.assertCanManage(field.product_id, userId, role);

    return this.prisma.productCustomField.delete({ where: { id } });
  }

  async reorder(
    productId: string,
    fieldIds: string[],
    userId: string,
    role: UserRole,
  ) {
    await this.assertCanManage(productId, userId, role);

    // Only touch fields that belong to this product: an id from another
    // product must not be re-sorted through this route.
    const updates = (fieldIds || []).map((id, index) =>
      this.prisma.productCustomField.updateMany({
        where: { id, product_id: productId },
        data: { sort_order: index },
      }),
    );
    await Promise.all(updates);

    return this.findByProduct(productId);
  }

  private async findFieldOrThrow(id: string) {
    const field = await this.prisma.productCustomField.findUnique({
      where: { id },
      select: { id: true, product_id: true },
    });
    if (!field)
      throw new NotFoundException({
        code: 'CUSTOM_FIELD_NOT_FOUND',
        message: 'Custom field not found',
      });
    return field;
  }

  /**
   * Ownership gate for every write. ADMIN always passes; a PROVIDER must own
   * the product through provider.user_id and a CREATOR through
   * creator.user_id. Anything else (other role, foreign product) is refused.
   */
  private async assertCanManage(
    productId: string,
    userId: string,
    role: UserRole,
  ) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        provider: { select: { user_id: true } },
        creator: { select: { user_id: true } },
      },
    });
    if (!product)
      throw new NotFoundException({
        code: 'CUSTOM_FIELD_PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });

    if (role === UserRole.ADMIN) return;

    const owns =
      (role === UserRole.PROVIDER &&
        !!userId &&
        product.provider?.user_id === userId) ||
      (role === UserRole.CREATOR &&
        !!userId &&
        product.creator?.user_id === userId);

    if (!owns)
      throw new ForbiddenException({
        code: 'CUSTOM_FIELD_FORBIDDEN',
        message: 'Not your product',
      });
  }
}
