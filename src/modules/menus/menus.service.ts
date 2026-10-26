import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MenuItemKind, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { CreateMenuDto, SetMenuItemsDto, UpdateMenuDto } from './dto/menus.dto';
import { MENU_MAX_DEPTH } from '../creator-categories/primary-collection';

/**
 * M6: the editor nests at most three levels. Throws `MENU_MAX_DEPTH` when
 * any branch of the sent tree is deeper.
 */
export function assertMenuDepth(
  nodes: SetMenuItemsDto['items'] | undefined,
  level = 1,
): void {
  if (!nodes?.length) return;
  if (level > MENU_MAX_DEPTH) {
    throw new BadRequestException({
      code: 'MENU_MAX_DEPTH',
      message: `Menu items can be nested at most ${MENU_MAX_DEPTH} levels deep`,
    });
  }
  for (const n of nodes) assertMenuDepth(n.children, level + 1);
}

/** A stored `label_i18n` JSON as a locale → label map (anything else = empty). */
function asLocaleMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v !== '') out[k] = v;
  }
  return out;
}

/**
 * The `label_i18n` to store for one item: the stored map when the payload
 * omits it; otherwise the stored map with the sent locales applied (''/null
 * removes a locale). A new item (no stored map) stores what was sent.
 */
export function mergeLabelI18n(
  stored: Record<string, string> | undefined,
  sent: Record<string, unknown> | undefined,
): Record<string, string> {
  if (sent === undefined) return { ...(stored ?? {}) };
  const out: Record<string, string> = { ...(stored ?? {}) };
  for (const [locale, label] of Object.entries(sent)) {
    if (typeof label === 'string' && label !== '') out[locale] = label;
    else delete out[locale];
  }
  return out;
}

@Injectable()
export class MenusService {
  constructor(
    private prisma: PrismaService,
    private revalidation: RevalidationService,
  ) {}

  private async resolveCreatorStoreId(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator)
      throw new NotFoundException({
        code: 'MENU_CREATOR_NOT_FOUND',
        message: 'Creator not found',
      });
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      select: { id: true },
    });
    if (!store)
      throw new NotFoundException({
        code: 'MENU_STORE_NOT_FOUND',
        message: 'Store not found',
      });
    return store.id;
  }

  private async assertMenuBelongsToStore(menuId: string, storeId: string) {
    const menu = await this.prisma.menu.findUnique({
      where: { id: menuId },
      select: { id: true, store_id: true },
    });
    if (!menu)
      throw new NotFoundException({
        code: 'MENU_NOT_FOUND',
        message: 'Menu not found',
      });
    if (menu.store_id !== storeId)
      throw new ForbiddenException({
        code: 'MENU_NOT_OWNED',
        message: 'Not your menu',
      });
  }

  // ── Menu CRUD ───────────────────────────────────────────

  async listByStore(userId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    return this.prisma.menu.findMany({
      where: { store_id: storeId },
      include: { items: { orderBy: { sort_order: 'asc' } } },
      orderBy: { created_at: 'asc' },
    });
  }

  async getById(userId: string, menuId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertMenuBelongsToStore(menuId, storeId);
    return this.prisma.menu.findUnique({
      where: { id: menuId },
      include: { items: { orderBy: { sort_order: 'asc' } } },
    });
  }

  async create(userId: string, dto: CreateMenuDto) {
    const storeId = await this.resolveCreatorStoreId(userId);
    try {
      return await this.prisma.menu.create({
        data: { store_id: storeId, key: dto.key, name: dto.name },
        include: { items: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'MENU_KEY_ALREADY_EXISTS',
          message: 'A menu with this key already exists',
        });
      }
      throw err;
    }
  }

  /**
   * Updates the menu row only (`key`, `name`). The items are never part of
   * this call: the editor replaces them wholesale through `setItems`, which
   * carries the per-item `label_i18n` over (M5 A-X).
   */
  async update(userId: string, menuId: string, dto: UpdateMenuDto) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertMenuBelongsToStore(menuId, storeId);
    const data: Prisma.MenuUpdateInput = {};
    if (dto.key !== undefined) data.key = dto.key;
    if (dto.name !== undefined) data.name = dto.name;
    try {
      const updated = await this.prisma.menu.update({
        where: { id: menuId },
        data,
        include: { items: { orderBy: { sort_order: 'asc' } } },
      });
      await this.revalidation.revalidateStoreById(storeId);
      return updated;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException({
          code: 'MENU_KEY_ALREADY_EXISTS',
          message: 'A menu with this key already exists',
        });
      }
      throw err;
    }
  }

  async delete(userId: string, menuId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertMenuBelongsToStore(menuId, storeId);
    const deleted = await this.prisma.menu.delete({ where: { id: menuId } });
    await this.revalidation.revalidateStoreById(storeId);
    return deleted;
  }

  // ── Items ───────────────────────────────────────────────

  /**
   * Replace a menu's items wholesale with the editor's ordered tree. We
   * wipe + recreate inside a transaction: simpler than diffing, and the
   * menu item count is small (a nav list), so the churn is negligible.
   * sort_order is derived from array position within each level; nested
   * `children` are created recursively with parent_id set to the row just
   * created for them.
   *
   * X19 carry-over (M5 A-X): an item re-sent with its `id` keeps the
   * stored `label_i18n` of every locale the payload does not mention
   * (`label_i18n` absent = all kept; a locale sent as ''/null is cleared),
   * so an editor that saves one language never wipes the others. The row
   * is recreated under the same id, so the next save still matches it.
   */
  async setItems(userId: string, menuId: string, dto: SetMenuItemsDto) {
    assertMenuDepth(dto.items);
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertMenuBelongsToStore(menuId, storeId);

    const result = await this.prisma.$transaction(async (tx) => {
      const stored = await tx.menuItem.findMany({
        where: { menu_id: menuId },
        select: { id: true, label_i18n: true },
      });
      const storedI18n = new Map(
        stored.map((r) => [r.id, asLocaleMap(r.label_i18n)]),
      );
      await tx.menuItem.deleteMany({ where: { menu_id: menuId } });

      const createLevel = async (
        nodes: SetMenuItemsDto['items'],
        parentId: string | null,
      ) => {
        for (let i = 0; i < nodes.length; i++) {
          const item = nodes[i];
          const previous =
            item.id && storedI18n.has(item.id)
              ? storedI18n.get(item.id)
              : undefined;
          const created = await tx.menuItem.create({
            data: {
              // Keep the id of a re-sent item of this menu (never a foreign one).
              ...(previous !== undefined ? { id: item.id } : {}),
              menu_id: menuId,
              parent_id: parentId,
              sort_order: i,
              kind: item.kind ?? MenuItemKind.CUSTOM,
              resource_id:
                (item.kind ?? MenuItemKind.CUSTOM) === MenuItemKind.CUSTOM
                  ? null
                  : (item.resource_id ?? null),
              label: item.label,
              label_i18n: mergeLabelI18n(
                previous,
                item.label_i18n,
              ) as Prisma.InputJsonValue,
              url: item.url,
              open_in_new_tab: item.open_in_new_tab ?? false,
            },
          });
          if (item.children?.length) {
            await createLevel(item.children, created.id);
          }
        }
      };

      await createLevel(dto.items, null);

      return tx.menu.findUnique({
        where: { id: menuId },
        include: { items: { orderBy: { sort_order: 'asc' } } },
      });
    });

    // Header/footer chrome reads menus from the cached store layout — flush it
    // so the new nav (and its sub-items) show up immediately.
    await this.revalidation.revalidateStoreById(storeId);

    return result;
  }
}
