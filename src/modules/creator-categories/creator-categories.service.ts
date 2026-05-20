import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCreatorCategoryDto,
  UpdateCreatorCategoryDto,
  ReorderCreatorCategoriesDto,
} from './dto/creator-category.dto';
import { CreatorCategoryMatchRule } from '@prisma/client';

@Injectable()
export class CreatorCategoriesService {
  constructor(private prisma: PrismaService) {}

  private async getCreatorIdOrThrow(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator) throw new NotFoundException('Creator profile not found');
    return creator.id;
  }

  private async assertOwnership(id: string, creatorId: string) {
    const found = await this.prisma.creatorCategory.findUnique({
      where: { id },
      select: { creator_id: true },
    });
    if (!found) throw new NotFoundException('Collection not found');
    if (found.creator_id !== creatorId) {
      throw new ForbiddenException('Not your collection');
    }
  }

  // Prevent assigning a parent that would create a cycle (parent ↔ descendant).
  private async assertNoCycle(id: string, parentId: string | null | undefined) {
    if (!parentId || parentId === id) {
      if (parentId === id) {
        throw new BadRequestException('A collection cannot be its own parent');
      }
      return;
    }
    let cursor: string | null = parentId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === id) {
        throw new BadRequestException('Cycle detected in collection hierarchy');
      }
      if (seen.has(cursor)) break;
      seen.add(cursor);
      const next: { parent_id: string | null } | null =
        await this.prisma.creatorCategory.findUnique({
          where: { id: cursor },
          select: { parent_id: true },
        });
      cursor = next?.parent_id ?? null;
    }
  }

  async create(userId: string, dto: CreateCreatorCategoryDto) {
    const creatorId = await this.getCreatorIdOrThrow(userId);
    const {
      translations,
      product_ids,
      custom_product_ids,
      match_tags,
      parent_id,
      ...data
    } = dto;

    if (parent_id) {
      const parent = await this.prisma.creatorCategory.findUnique({
        where: { id: parent_id },
        select: { creator_id: true },
      });
      if (!parent || parent.creator_id !== creatorId) {
        throw new BadRequestException('Invalid parent collection');
      }
    }

    const created = await this.prisma.creatorCategory.create({
      data: {
        ...data,
        match_tags: match_tags ?? [],
        parent_id: parent_id ?? null,
        creator_id: creatorId,
        translations: { create: translations },
      },
      include: { translations: true },
    });

    if (product_ids?.length) {
      await this.attachProducts(created.id, creatorId, product_ids);
    }
    if (custom_product_ids?.length) {
      await this.attachCustomProducts(created.id, creatorId, custom_product_ids);
    }

    return this.findById(created.id, userId);
  }

  async findAll(userId: string) {
    const creatorId = await this.getCreatorIdOrThrow(userId);
    const rows = await this.prisma.creatorCategory.findMany({
      where: { creator_id: creatorId },
      include: {
        translations: true,
        _count: {
          select: { products: true, custom_products: true, children: true },
        },
      },
      orderBy: [{ parent_id: 'asc' }, { sort_order: 'asc' }],
    });
    // Build tree
    type Node = (typeof rows)[number] & { children: Node[] };
    const map = new Map<string, Node>();
    rows.forEach((r) => map.set(r.id, { ...r, children: [] }));
    const roots: Node[] = [];
    for (const node of map.values()) {
      if (node.parent_id && map.has(node.parent_id)) {
        map.get(node.parent_id)!.children.push(node);
      } else {
        roots.push(node);
      }
    }
    return roots;
  }

  async findById(id: string, userId: string) {
    const creatorId = await this.getCreatorIdOrThrow(userId);
    await this.assertOwnership(id, creatorId);

    const cc = await this.prisma.creatorCategory.findUnique({
      where: { id },
      include: {
        translations: true,
        parent: { include: { translations: true } },
        children: { include: { translations: true } },
        products: {
          include: {
            product: {
              include: {
                translations: true,
                images: { take: 1, orderBy: { sort_order: 'asc' } },
                tags: true,
              },
            },
          },
          orderBy: { sort_order: 'asc' },
        },
        custom_products: {
          include: {
            custom_product: {
              include: {
                translations: true,
                mockup_images: { take: 1, orderBy: { sort_order: 'asc' } },
                product: {
                  include: {
                    translations: true,
                    images: { take: 1, orderBy: { sort_order: 'asc' } },
                  },
                },
              },
            },
          },
          orderBy: { sort_order: 'asc' },
        },
      },
    });
    if (!cc) throw new NotFoundException('Collection not found');
    return cc;
  }

  async update(id: string, userId: string, dto: UpdateCreatorCategoryDto) {
    const creatorId = await this.getCreatorIdOrThrow(userId);
    await this.assertOwnership(id, creatorId);

    const {
      translations,
      product_ids,
      custom_product_ids,
      parent_id,
      match_tags,
      ...data
    } = dto;

    if (parent_id !== undefined) {
      if (parent_id) {
        const parent = await this.prisma.creatorCategory.findUnique({
          where: { id: parent_id },
          select: { creator_id: true },
        });
        if (!parent || parent.creator_id !== creatorId) {
          throw new BadRequestException('Invalid parent collection');
        }
        await this.assertNoCycle(id, parent_id);
      }
    }

    await this.prisma.creatorCategory.update({
      where: { id },
      data: {
        ...data,
        ...(parent_id !== undefined ? { parent_id } : {}),
        ...(match_tags !== undefined ? { match_tags } : {}),
      },
    });

    if (translations) {
      await this.prisma.creatorCategoryTranslation.deleteMany({
        where: { creator_category_id: id },
      });
      await this.prisma.creatorCategoryTranslation.createMany({
        data: translations.map((t) => ({
          ...t,
          creator_category_id: id,
        })),
      });
    }

    if (product_ids !== undefined) {
      await this.prisma.productCreatorCategory.deleteMany({
        where: { creator_category_id: id },
      });
      if (product_ids.length) {
        await this.attachProducts(id, creatorId, product_ids);
      }
    }

    if (custom_product_ids !== undefined) {
      await this.prisma.customProductCreatorCategory.deleteMany({
        where: { creator_category_id: id },
      });
      if (custom_product_ids.length) {
        await this.attachCustomProducts(id, creatorId, custom_product_ids);
      }
    }

    return this.findById(id, userId);
  }

  async delete(id: string, userId: string) {
    const creatorId = await this.getCreatorIdOrThrow(userId);
    await this.assertOwnership(id, creatorId);
    // children's parent_id is SET NULL via FK
    return this.prisma.creatorCategory.delete({ where: { id } });
  }

  async reorder(userId: string, dto: ReorderCreatorCategoriesDto) {
    const creatorId = await this.getCreatorIdOrThrow(userId);
    const owned = await this.prisma.creatorCategory.findMany({
      where: { id: { in: dto.ids }, creator_id: creatorId },
      select: { id: true },
    });
    if (owned.length !== dto.ids.length) {
      throw new ForbiddenException('Cannot reorder collections you do not own');
    }
    await this.prisma.$transaction(
      dto.ids.map((id, idx) =>
        this.prisma.creatorCategory.update({
          where: { id },
          data: { sort_order: idx },
        }),
      ),
    );
    return { ok: true };
  }

  /**
   * Resolve the products that belong to a collection, honoring MANUAL vs TAGS
   * rules. For TAGS, matches any product owned by the creator whose tag set
   * intersects match_tags.
   */
  async getProducts(id: string, userId: string) {
    const creatorId = await this.getCreatorIdOrThrow(userId);
    await this.assertOwnership(id, creatorId);

    const cc = await this.prisma.creatorCategory.findUnique({
      where: { id },
      select: { match_rule: true, match_tags: true },
    });
    if (!cc) throw new NotFoundException('Collection not found');

    if (cc.match_rule === CreatorCategoryMatchRule.TAGS) {
      if (!cc.match_tags?.length) return [];
      return this.prisma.product.findMany({
        where: {
          creator_id: creatorId,
          tags: { some: { tag: { in: cc.match_tags } } },
        },
        include: {
          translations: true,
          images: { take: 1, orderBy: { sort_order: 'asc' } },
          tags: true,
        },
        orderBy: { created_at: 'desc' },
      });
    }

    // MANUAL — return both own products and custom products linked to the
    // collection. Custom-product rows are tagged with __kind so the storefront
    // can render them differently from regular products if needed.
    const [productLinks, customLinks] = await Promise.all([
      this.prisma.productCreatorCategory.findMany({
        where: { creator_category_id: id },
        include: {
          product: {
            include: {
              translations: true,
              images: { take: 1, orderBy: { sort_order: 'asc' } },
              tags: true,
            },
          },
        },
        orderBy: { sort_order: 'asc' },
      }),
      this.prisma.customProductCreatorCategory.findMany({
        where: { creator_category_id: id },
        include: {
          custom_product: {
            include: {
              translations: true,
              mockup_images: { take: 1, orderBy: { sort_order: 'asc' } },
              product: {
                include: {
                  translations: true,
                  images: { take: 1, orderBy: { sort_order: 'asc' } },
                },
              },
            },
          },
        },
        orderBy: { sort_order: 'asc' },
      }),
    ]);

    return [
      ...productLinks.map((l) => ({ __kind: 'product' as const, ...l.product })),
      ...customLinks.map((l) => ({
        __kind: 'custom_product' as const,
        ...l.custom_product,
      })),
    ];
  }

  // ── internal helpers ──────────────────────────────────────

  private async attachProducts(
    creatorCategoryId: string,
    creatorId: string,
    productIds: string[],
  ) {
    // Only attach products this creator actually owns.
    const owned = await this.prisma.product.findMany({
      where: { id: { in: productIds }, creator_id: creatorId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((p) => p.id));
    const toAttach = productIds.filter((id) => ownedIds.has(id));
    if (!toAttach.length) return;
    await this.prisma.productCreatorCategory.createMany({
      data: toAttach.map((product_id, sort_order) => ({
        product_id,
        creator_category_id: creatorCategoryId,
        sort_order,
      })),
      skipDuplicates: true,
    });
  }

  private async attachCustomProducts(
    creatorCategoryId: string,
    creatorId: string,
    customProductIds: string[],
  ) {
    // Only attach custom products this creator actually owns.
    const owned = await this.prisma.customProduct.findMany({
      where: { id: { in: customProductIds }, creator_id: creatorId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((p) => p.id));
    const toAttach = customProductIds.filter((id) => ownedIds.has(id));
    if (!toAttach.length) return;
    await this.prisma.customProductCreatorCategory.createMany({
      data: toAttach.map((custom_product_id, sort_order) => ({
        custom_product_id,
        creator_category_id: creatorCategoryId,
        sort_order,
      })),
      skipDuplicates: true,
    });
  }
}
