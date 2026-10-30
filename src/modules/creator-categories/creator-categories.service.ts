import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import {
  CreateCreatorCategoryDto,
  UpdateCreatorCategoryDto,
  ReorderCreatorCategoriesDto,
  CreatorCategoryTranslationDto,
} from './dto/creator-category.dto';
import {
  CreatorCategoryMatchRule,
  CreatorCategoryVisibility,
  Prisma,
} from '@prisma/client';
import { sanitizeCreatorHtml } from '../../common/html/creator-html';
import { CREATOR_CATEGORY_MAX_DEPTH } from './primary-collection';
import {
  compareManualOrder,
  computeLinkSortOrders,
  mergedProductOrder,
  productOrderIndex,
  productOrderToken,
} from './product-order';

/**
 * Collection descriptions (short `description`, M6.2 `long_description`) are
 * rendered as HTML on the storefront. An `undefined` field is left alone so
 * the X19 carry-over still works.
 */
function sanitizeTranslation<
  T extends { description?: string | null; long_description?: string | null },
>(t: T): T {
  const out = { ...t };
  if (t.description !== undefined)
    out.description = sanitizeCreatorHtml(t.description);
  if (t.long_description !== undefined)
    out.long_description = sanitizeCreatorHtml(t.long_description);
  return out;
}

@Injectable()
export class CreatorCategoriesService {
  constructor(
    private prisma: PrismaService,
    private readonly revalidation: RevalidationService,
  ) {}

  /**
   * Collections feed menus, breadcrumbs, listing pages and the sitemap, which
   * the storefront caches per store (1 h): every write refreshes the store
   * tag so an edit is visible within seconds (Namez go-live Phase 3.2).
   */
  private async refreshStorefront(creatorId: string): Promise<void> {
    await this.revalidation.revalidateStoreByCreatorId(creatorId);
  }

  private async getCreatorIdOrThrow(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'CREATOR_CATEGORY_CREATOR_PROFILE_NOT_FOUND',
        message: 'Creator profile not found',
      });
    return creator.id;
  }

  /** Ownership check; returns the stored visibility and parent (M6.3). */
  private async assertOwnership(id: string, creatorId: string) {
    const found = await this.prisma.creatorCategory.findUnique({
      where: { id },
      select: { creator_id: true, visibility: true, parent_id: true },
    });
    if (!found)
      throw new NotFoundException({
        code: 'CREATOR_CATEGORY_NOT_FOUND',
        message: 'Collection not found',
      });
    if (found.creator_id !== creatorId) {
      throw new ForbiddenException({
        code: 'CREATOR_CATEGORY_NOT_OWNED',
        message: 'Not your collection',
      });
    }
    return found;
  }

  /**
   * M6.3: INTERNAL collections are flat labels. A parent may not be chosen
   * for an INTERNAL collection (CREATOR_CATEGORY_INTERNAL_NO_PARENT) and an
   * INTERNAL collection may not be a parent
   * (CREATOR_CATEGORY_PARENT_INTERNAL). `parent` is the parent row when
   * one is being set.
   */
  private assertVisibilityAllowsParent(
    visibility: CreatorCategoryVisibility,
    parentId: string | null | undefined,
    parent: { visibility: CreatorCategoryVisibility } | null,
  ) {
    if (!parentId) return;
    if (visibility === CreatorCategoryVisibility.INTERNAL) {
      throw new BadRequestException({
        code: 'CREATOR_CATEGORY_INTERNAL_NO_PARENT',
        message: 'An internal label cannot have a parent collection',
      });
    }
    if (parent?.visibility === CreatorCategoryVisibility.INTERNAL) {
      throw new BadRequestException({
        code: 'CREATOR_CATEGORY_PARENT_INTERNAL',
        message: 'An internal label cannot be a parent collection',
      });
    }
  }

  // Prevent assigning a parent that would create a cycle (parent ↔ descendant).
  private async assertNoCycle(id: string, parentId: string | null | undefined) {
    if (!parentId || parentId === id) {
      if (parentId === id) {
        throw new BadRequestException({
          code: 'CREATOR_CATEGORY_SELF_PARENT',
          message: 'A collection cannot be its own parent',
        });
      }
      return;
    }
    let cursor: string | null = parentId;
    const seen = new Set<string>();
    while (cursor) {
      if (cursor === id) {
        throw new BadRequestException({
          code: 'CREATOR_CATEGORY_CYCLE_DETECTED',
          message: 'Cycle detected in collection hierarchy',
        });
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

  /** Depth of a collection: root = 0, child = 1, ... (walks parent_id). */
  private async depthOf(id: string): Promise<number> {
    let depth = 0;
    let cursor: string | null = id;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const row: { parent_id: string | null } | null =
        await this.prisma.creatorCategory.findUnique({
          where: { id: cursor },
          select: { parent_id: true },
        });
      cursor = row?.parent_id ?? null;
      if (cursor) depth++;
    }
    return depth;
  }

  /** Height of the subtree under `id`: 0 = no children, 1 = children only, ... */
  private async subtreeHeight(id: string): Promise<number> {
    const children = await this.prisma.creatorCategory.findMany({
      where: { parent_id: id },
      select: { id: true },
    });
    if (!children.length) return 0;
    let max = 0;
    for (const c of children) {
      max = Math.max(max, await this.subtreeHeight(c.id));
    }
    return max + 1;
  }

  /**
   * M6: three levels at most (root = 0, grandchild = 2). On create the
   * parent must be at depth <= 1; on a move, the node's new depth plus the
   * height of the subtree it carries must stay <= 2.
   */
  private async assertDepthAllowed(
    parentId: string | null | undefined,
    movedId?: string,
  ) {
    if (!parentId) return;
    const depth = (await this.depthOf(parentId)) + 1;
    const height = movedId ? await this.subtreeHeight(movedId) : 0;
    if (depth + height > CREATOR_CATEGORY_MAX_DEPTH) {
      throw new BadRequestException({
        code: 'CREATOR_CATEGORY_MAX_DEPTH',
        message: `Collections can be nested at most ${CREATOR_CATEGORY_MAX_DEPTH + 1} levels deep`,
      });
    }
  }

  async create(userId: string, dto: CreateCreatorCategoryDto) {
    const creatorId = await this.getCreatorIdOrThrow(userId);
    const {
      translations,
      product_ids,
      custom_product_ids,
      product_order,
      match_tags,
      parent_id,
      ...data
    } = dto;

    if (parent_id) {
      const parent = await this.prisma.creatorCategory.findUnique({
        where: { id: parent_id },
        select: { creator_id: true, visibility: true },
      });
      if (!parent || parent.creator_id !== creatorId) {
        throw new BadRequestException({
          code: 'CREATOR_CATEGORY_INVALID_PARENT',
          message: 'Invalid parent collection',
        });
      }
      this.assertVisibilityAllowsParent(
        data.visibility ?? CreatorCategoryVisibility.PUBLIC,
        parent_id,
        parent,
      );
      await this.assertDepthAllowed(parent_id);
    }

    const created = await this.prisma.creatorCategory.create({
      data: {
        ...data,
        match_tags: match_tags ?? [],
        parent_id: parent_id ?? null,
        creator_id: creatorId,
        translations: { create: translations.map(sanitizeTranslation) },
      },
      include: { translations: true },
    });

    await this.writeProductLinks(created.id, creatorId, {
      product_ids: product_ids?.length ? product_ids : undefined,
      custom_product_ids: custom_product_ids?.length
        ? custom_product_ids
        : undefined,
      product_order,
      replace: false,
    });

    await this.refreshStorefront(creatorId);
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
    if (!cc)
      throw new NotFoundException({
        code: 'CREATOR_CATEGORY_NOT_FOUND',
        message: 'Collection not found',
      });
    // Merged manual order of both kinds (`p:<id>` / `cp:<id>`), in the order
    // the storefront lists a MANUAL collection.
    const product_order = mergedProductOrder(
      (cc.products ?? []).map((l) => ({
        id: l.product_id,
        sort_order: l.sort_order,
        created_at: l.product?.created_at,
      })),
      (cc.custom_products ?? []).map((l) => ({
        id: l.custom_product_id,
        sort_order: l.sort_order,
        created_at: l.custom_product?.created_at,
      })),
    );
    return { ...cc, product_order };
  }

  async update(id: string, userId: string, dto: UpdateCreatorCategoryDto) {
    const creatorId = await this.getCreatorIdOrThrow(userId);
    const current = await this.assertOwnership(id, creatorId);

    const {
      translations,
      product_ids,
      custom_product_ids,
      product_order,
      parent_id,
      match_tags,
      ...data
    } = dto;

    // M6.3: the visibility the row will have after this update, and the
    // parent it will end up with (`undefined` = unchanged).
    const visibility =
      data.visibility ?? current.visibility ?? CreatorCategoryVisibility.PUBLIC;
    const effectiveParentId =
      parent_id !== undefined ? parent_id : (current.parent_id ?? null);
    const becomesInternal =
      data.visibility === CreatorCategoryVisibility.INTERNAL &&
      current.visibility !== CreatorCategoryVisibility.INTERNAL;

    if (parent_id !== undefined) {
      if (parent_id) {
        const parent = await this.prisma.creatorCategory.findUnique({
          where: { id: parent_id },
          select: { creator_id: true, visibility: true },
        });
        if (!parent || parent.creator_id !== creatorId) {
          throw new BadRequestException({
            code: 'CREATOR_CATEGORY_INVALID_PARENT',
            message: 'Invalid parent collection',
          });
        }
        this.assertVisibilityAllowsParent(visibility, parent_id, parent);
        await this.assertNoCycle(id, parent_id);
        await this.assertDepthAllowed(parent_id, id);
      }
    } else if (visibility === CreatorCategoryVisibility.INTERNAL) {
      // Switching to INTERNAL while keeping a stored parent: the dashboard
      // sends `parent_id: null` together with the switch.
      this.assertVisibilityAllowsParent(visibility, effectiveParentId, null);
    }

    if (data.visibility === CreatorCategoryVisibility.INTERNAL) {
      const children = await this.prisma.creatorCategory.count({
        where: { parent_id: id },
      });
      if (children > 0) {
        throw new BadRequestException({
          code: 'CREATOR_CATEGORY_INTERNAL_HAS_CHILDREN',
          message:
            'A collection with sub-collections cannot become an internal label',
        });
      }
    }

    await this.prisma.$transaction([
      this.prisma.creatorCategory.update({
        where: { id },
        data: {
          ...data,
          ...(parent_id !== undefined ? { parent_id } : {}),
          ...(match_tags !== undefined ? { match_tags } : {}),
        },
      }),
      // M6.3: an INTERNAL collection is never a product's primary one, so
      // the primaries that pointed at it are cleared in the same transaction
      // (the product editors re-pick the first PUBLIC link on their next save).
      ...(becomesInternal
        ? [
            this.prisma.product.updateMany({
              where: { primary_creator_category_id: id },
              data: { primary_creator_category_id: null },
            }),
            this.prisma.customProduct.updateMany({
              where: { primary_creator_category_id: id },
              data: { primary_creator_category_id: null },
            }),
          ]
        : []),
    ]);

    if (translations) {
      // X19 carry-over (M5 A-X, same semantics as ProductsService): only the
      // locales sent are rewritten, so saving one language never wipes the
      // others; within a sent row `undefined` keeps the stored value of
      // that locale and an explicit empty (`null`/'') clears it.
      const rows = await this.withTranslationCarryOver(id, translations);
      await this.prisma.$transaction([
        this.prisma.creatorCategoryTranslation.deleteMany({
          where: {
            creator_category_id: id,
            locale: { in: rows.map((t) => t.locale) },
          },
        }),
        this.prisma.creatorCategoryTranslation.createMany({
          data: rows.map((t) => ({
            ...sanitizeTranslation(t),
            creator_category_id: id,
          })),
        }),
      ]);
    }

    await this.writeProductLinks(id, creatorId, {
      product_ids,
      custom_product_ids,
      product_order,
      replace: true,
    });

    await this.refreshStorefront(creatorId);
    return this.findById(id, userId);
  }

  /**
   * X19 carry-over for the sent rows: `description`, `long_description`
   * (M6.2), `meta_title` and `meta_desc` left `undefined` keep the value
   * stored for the same locale; `null`/'' clears. Reads only when a row
   * omits one of them. Locales not sent are not touched by the caller at all.
   */
  private async withTranslationCarryOver(
    categoryId: string,
    translations: CreatorCategoryTranslationDto[],
  ): Promise<
    (Omit<CreatorCategoryTranslationDto, 'description' | 'long_description'> & {
      description: string | null;
      long_description: string | null;
    })[]
  > {
    const omits = translations.some(
      (t) =>
        t.description === undefined ||
        t.long_description === undefined ||
        t.meta_title === undefined ||
        t.meta_desc === undefined,
    );
    const byLocale = new Map<
      string,
      {
        description: string | null;
        long_description: string | null;
        meta_title: string | null;
        meta_desc: string | null;
      }
    >();
    if (omits) {
      const stored = await this.prisma.creatorCategoryTranslation.findMany({
        where: {
          creator_category_id: categoryId,
          locale: { in: translations.map((t) => t.locale) },
        },
        select: {
          locale: true,
          description: true,
          long_description: true,
          meta_title: true,
          meta_desc: true,
        },
      });
      for (const r of stored) byLocale.set(r.locale, r);
    }
    const keep = (
      sent: string | null | undefined,
      stored: string | null | undefined,
    ): string | null => (sent === undefined ? (stored ?? null) : sent || null);
    return translations.map((t) => {
      const prev = byLocale.get(t.locale);
      return {
        ...t,
        description: keep(t.description, prev?.description),
        long_description: keep(t.long_description, prev?.long_description),
        meta_title: keep(t.meta_title, prev?.meta_title),
        meta_desc: keep(t.meta_desc, prev?.meta_desc),
      };
    });
  }

  async delete(id: string, userId: string) {
    const creatorId = await this.getCreatorIdOrThrow(userId);
    await this.assertOwnership(id, creatorId);
    // children's parent_id is SET NULL via FK
    const deleted = await this.prisma.creatorCategory.delete({ where: { id } });
    await this.refreshStorefront(creatorId);
    return deleted;
  }

  async reorder(userId: string, dto: ReorderCreatorCategoriesDto) {
    const creatorId = await this.getCreatorIdOrThrow(userId);
    const owned = await this.prisma.creatorCategory.findMany({
      where: { id: { in: dto.ids }, creator_id: creatorId },
      select: { id: true },
    });
    if (owned.length !== dto.ids.length) {
      throw new ForbiddenException({
        code: 'CREATOR_CATEGORY_REORDER_NOT_OWNED',
        message: 'Cannot reorder collections you do not own',
      });
    }
    await this.prisma.$transaction(
      dto.ids.map((id, idx) =>
        this.prisma.creatorCategory.update({
          where: { id },
          data: { sort_order: idx },
        }),
      ),
    );
    await this.refreshStorefront(creatorId);
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
    if (!cc)
      throw new NotFoundException({
        code: 'CREATOR_CATEGORY_NOT_FOUND',
        message: 'Collection not found',
      });

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

    // Merged manual order (same as the storefront and `product_order`).
    return [
      ...productLinks.map((l) => ({
        key: {
          kind: 'p' as const,
          id: l.product_id,
          sort_order: l.sort_order,
          created_at: l.product.created_at,
        },
        row: { __kind: 'product' as const, ...l.product },
      })),
      ...customLinks.map((l) => ({
        key: {
          kind: 'cp' as const,
          id: l.custom_product_id,
          sort_order: l.sort_order,
          created_at: l.custom_product.created_at,
        },
        row: { __kind: 'custom_product' as const, ...l.custom_product },
      })),
    ]
      .sort((a, b) => compareManualOrder(a.key, b.key))
      .map((e) => e.row);
  }

  // ── internal helpers ──────────────────────────────────────

  /**
   * Link rewrite + manual order of a collection in ONE transaction, so a
   * failure never leaves the collection emptied or half-ordered. `replace`
   * deletes the existing links of a kind whose id list was sent (update);
   * an undefined list leaves that kind untouched. New links are created at
   * their `product_order` index directly, so applying the order afterwards
   * only writes the few rows it still moves.
   */
  private async writeProductLinks(
    creatorCategoryId: string,
    creatorId: string,
    links: {
      product_ids?: string[];
      custom_product_ids?: string[];
      product_order?: string[];
      replace: boolean;
    },
  ) {
    const { product_ids, custom_product_ids, product_order, replace } = links;
    if (
      product_ids === undefined &&
      custom_product_ids === undefined &&
      product_order === undefined
    )
      return;
    const orderIndex = product_order
      ? productOrderIndex(product_order)
      : undefined;
    await this.prisma.$transaction(
      async (tx) => {
        if (product_ids !== undefined) {
          if (replace)
            await tx.productCreatorCategory.deleteMany({
              where: { creator_category_id: creatorCategoryId },
            });
          if (product_ids.length)
            await this.attachProducts(
              tx,
              creatorCategoryId,
              creatorId,
              product_ids,
              orderIndex,
            );
        }
        if (custom_product_ids !== undefined) {
          if (replace)
            await tx.customProductCreatorCategory.deleteMany({
              where: { creator_category_id: creatorCategoryId },
            });
          if (custom_product_ids.length)
            await this.attachCustomProducts(
              tx,
              creatorCategoryId,
              creatorId,
              custom_product_ids,
              orderIndex,
            );
        }
        // Manual order across both kinds; applied after the links were
        // (re)written so new links take their place, and on its own it only
        // reorders the existing links.
        if (product_order !== undefined)
          await this.applyProductOrder(tx, creatorCategoryId, product_order);
      },
      // Large manual collections write many rows; the default 5s is tight.
      { timeout: 30_000 },
    );
  }

  /**
   * Rewrite the sort_order of the collection's links (both kinds, one index
   * space) from `order` tokens. Only existing links are touched — tokens of
   * products that are not linked are ignored — and only rows whose value
   * changes are written.
   */
  private async applyProductOrder(
    db: Prisma.TransactionClient,
    creatorCategoryId: string,
    order: string[],
  ) {
    const ownLinks = await db.productCreatorCategory.findMany({
      where: { creator_category_id: creatorCategoryId },
      select: { product_id: true, sort_order: true },
    });
    const customLinks = await db.customProductCreatorCategory.findMany({
      where: { creator_category_id: creatorCategoryId },
      select: { custom_product_id: true, sort_order: true },
    });
    const next = computeLinkSortOrders(
      order,
      ownLinks.map((l) => ({ id: l.product_id, sort_order: l.sort_order })),
      customLinks.map((l) => ({
        id: l.custom_product_id,
        sort_order: l.sort_order,
      })),
    );
    // Runs inside the caller's transaction; only the moved rows are written.
    for (const l of ownLinks) {
      const sort_order = next.own.get(l.product_id)!;
      if (sort_order === l.sort_order) continue;
      await db.productCreatorCategory.update({
        where: {
          product_id_creator_category_id: {
            product_id: l.product_id,
            creator_category_id: creatorCategoryId,
          },
        },
        data: { sort_order },
      });
    }
    for (const l of customLinks) {
      const sort_order = next.custom.get(l.custom_product_id)!;
      if (sort_order === l.sort_order) continue;
      await db.customProductCreatorCategory.update({
        where: {
          custom_product_id_creator_category_id: {
            custom_product_id: l.custom_product_id,
            creator_category_id: creatorCategoryId,
          },
        },
        data: { sort_order },
      });
    }
  }

  /**
   * Initial sort_order of a newly created link: its `product_order` index
   * (same numbering as computeLinkSortOrders), else past the order by
   * position; without an order, the position in the sent id list.
   */
  private static initialSortOrder(
    orderIndex: Map<string, number> | undefined,
    token: string,
    position: number,
  ): number {
    if (!orderIndex) return position;
    return orderIndex.get(token) ?? orderIndex.size + position;
  }

  private async attachProducts(
    db: Prisma.TransactionClient,
    creatorCategoryId: string,
    creatorId: string,
    productIds: string[],
    orderIndex?: Map<string, number>,
  ) {
    // Only attach products this creator actually owns.
    const owned = await db.product.findMany({
      where: { id: { in: productIds }, creator_id: creatorId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((p) => p.id));
    const toAttach = productIds.filter((id) => ownedIds.has(id));
    if (!toAttach.length) return;
    await db.productCreatorCategory.createMany({
      data: toAttach.map((product_id, i) => ({
        product_id,
        creator_category_id: creatorCategoryId,
        sort_order: CreatorCategoriesService.initialSortOrder(
          orderIndex,
          productOrderToken('p', product_id),
          i,
        ),
      })),
      skipDuplicates: true,
    });
  }

  private async attachCustomProducts(
    db: Prisma.TransactionClient,
    creatorCategoryId: string,
    creatorId: string,
    customProductIds: string[],
    orderIndex?: Map<string, number>,
  ) {
    // Only attach custom products this creator actually owns.
    const owned = await db.customProduct.findMany({
      where: { id: { in: customProductIds }, creator_id: creatorId },
      select: { id: true },
    });
    const ownedIds = new Set(owned.map((p) => p.id));
    const toAttach = customProductIds.filter((id) => ownedIds.has(id));
    if (!toAttach.length) return;
    await db.customProductCreatorCategory.createMany({
      data: toAttach.map((custom_product_id, i) => ({
        custom_product_id,
        creator_category_id: creatorCategoryId,
        sort_order: CreatorCategoriesService.initialSortOrder(
          orderIndex,
          productOrderToken('cp', custom_product_id),
          i,
        ),
      })),
      skipDuplicates: true,
    });
  }
}
