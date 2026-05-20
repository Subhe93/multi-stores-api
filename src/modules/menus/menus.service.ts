import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateMenuDto,
  SetMenuItemsDto,
  UpdateMenuDto,
} from './dto/menus.dto';

@Injectable()
export class MenusService {
  constructor(private prisma: PrismaService) {}

  private async resolveCreatorStoreId(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { id: true },
    });
    if (!creator) throw new NotFoundException('Creator not found');
    const store = await this.prisma.store.findUnique({
      where: { creator_id: creator.id },
      select: { id: true },
    });
    if (!store) throw new NotFoundException('Store not found');
    return store.id;
  }

  private async assertMenuBelongsToStore(menuId: string, storeId: string) {
    const menu = await this.prisma.menu.findUnique({
      where: { id: menuId },
      select: { id: true, store_id: true },
    });
    if (!menu) throw new NotFoundException('Menu not found');
    if (menu.store_id !== storeId) throw new ForbiddenException('Not your menu');
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
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A menu with this key already exists');
      }
      throw err;
    }
  }

  async update(userId: string, menuId: string, dto: UpdateMenuDto) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertMenuBelongsToStore(menuId, storeId);
    const data: Prisma.MenuUpdateInput = {};
    if (dto.key !== undefined) data.key = dto.key;
    if (dto.name !== undefined) data.name = dto.name;
    try {
      return await this.prisma.menu.update({
        where: { id: menuId },
        data,
        include: { items: { orderBy: { sort_order: 'asc' } } },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('A menu with this key already exists');
      }
      throw err;
    }
  }

  async delete(userId: string, menuId: string) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertMenuBelongsToStore(menuId, storeId);
    return this.prisma.menu.delete({ where: { id: menuId } });
  }

  // ── Items ───────────────────────────────────────────────

  /**
   * Replace a menu's items wholesale with the editor's ordered list. We
   * wipe + recreate inside a transaction: simpler than diffing, and the
   * menu item count is small (a nav list), so the churn is negligible.
   * sort_order is derived from array position. parent_id references are
   * resolved client-side via the existing item ids the editor passes back.
   */
  async setItems(userId: string, menuId: string, dto: SetMenuItemsDto) {
    const storeId = await this.resolveCreatorStoreId(userId);
    await this.assertMenuBelongsToStore(menuId, storeId);

    return this.prisma.$transaction(async (tx) => {
      await tx.menuItem.deleteMany({ where: { menu_id: menuId } });
      // Recreate top-level first so nested parent_id references resolve.
      // v1 editor only sends a flat list, so parent_id is typically null.
      for (let i = 0; i < dto.items.length; i++) {
        const item = dto.items[i];
        await tx.menuItem.create({
          data: {
            menu_id: menuId,
            parent_id: null, // flat in v1 — nesting handled in a later phase
            sort_order: i,
            label: item.label,
            label_i18n: (item.label_i18n ?? {}) as Prisma.InputJsonValue,
            url: item.url,
            open_in_new_tab: item.open_in_new_tab ?? false,
          },
        });
      }
      return tx.menu.findUnique({
        where: { id: menuId },
        include: { items: { orderBy: { sort_order: 'asc' } } },
      });
    });
  }
}
