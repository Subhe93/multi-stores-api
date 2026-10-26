import { MenusService, mergeLabelI18n } from './menus.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { RevalidationService } from '../../common/revalidation/revalidation.service';

// M5 A-X: `setItems` wipes and recreates the items, so the per-item
// `label_i18n` of locales the editor does not send must be carried over
// (X19), keyed by the item id the editor re-sends.

type Row = {
  id: string;
  menu_id: string;
  parent_id: string | null;
  sort_order: number;
  label: string;
  label_i18n: Record<string, string>;
  url: string;
  open_in_new_tab: boolean;
};

function build(stored: Row[]) {
  let rows = [...stored];
  let seq = 0;
  const prisma = {
    creator: { findUnique: jest.fn(() => Promise.resolve({ id: 'c1' })) },
    store: { findUnique: jest.fn(() => Promise.resolve({ id: 's1' })) },
    menu: {
      findUnique: jest.fn(() =>
        Promise.resolve({ id: 'm1', store_id: 's1', items: rows }),
      ),
    },
    menuItem: {
      findMany: jest.fn(() => Promise.resolve(rows)),
      deleteMany: jest.fn(() => {
        const n = rows.length;
        rows = [];
        return Promise.resolve({ count: n });
      }),
      create: jest.fn(({ data }: { data: Partial<Row> }) => {
        const row = { id: `new-${++seq}`, ...data } as Row;
        rows.push(row);
        return Promise.resolve(row);
      }),
    },
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) =>
      fn(prisma),
    ),
  };
  const revalidation = {
    revalidateStoreById: jest.fn(() => Promise.resolve()),
  };
  const service = new MenusService(
    prisma as unknown as PrismaService,
    revalidation as unknown as RevalidationService,
  );
  return { prisma, service, items: () => rows };
}

const HOME: Row = {
  id: 'item-home',
  menu_id: 'm1',
  parent_id: null,
  sort_order: 0,
  label: 'Hem',
  label_i18n: { en: 'Home', ar: 'الرئيسية' },
  url: '/',
  open_in_new_tab: false,
};

describe('mergeLabelI18n', () => {
  it('absent keeps all, sent locales win, empty clears, new item stores what was sent', () => {
    expect(mergeLabelI18n({ en: 'Home', ar: 'x' }, undefined)).toEqual({
      en: 'Home',
      ar: 'x',
    });
    expect(mergeLabelI18n({ en: 'Home', ar: 'x' }, { en: 'Start' })).toEqual({
      en: 'Start',
      ar: 'x',
    });
    expect(
      mergeLabelI18n({ en: 'Home', ar: 'x' }, { ar: '', en: null }),
    ).toEqual({});
    expect(mergeLabelI18n(undefined, { en: 'Home' })).toEqual({ en: 'Home' });
  });
});

describe('MenusService.setItems (M5 A-X label_i18n carry-over)', () => {
  it('an item re-sent by id without label_i18n keeps every stored locale and its id', async () => {
    const { service, items } = build([HOME]);
    await service.setItems('u1', 'm1', {
      items: [{ id: 'item-home', label: 'Hem', url: '/' }],
    });
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({
      id: 'item-home',
      label_i18n: { en: 'Home', ar: 'الرئيسية' },
    });
  });

  it('an item re-sent with one locale keeps the others; an empty locale clears it', async () => {
    const { service, items } = build([HOME]);
    await service.setItems('u1', 'm1', {
      items: [
        {
          id: 'item-home',
          label: 'Hem',
          url: '/',
          label_i18n: { en: 'Start', ar: '' },
        },
      ],
    });
    expect(items()[0].label_i18n).toEqual({ en: 'Start' });
  });

  it('a new item (no id, or a foreign id) stores what was sent and gets a fresh id', async () => {
    const { service, items } = build([HOME]);
    await service.setItems('u1', 'm1', {
      items: [
        { label: 'Butik', url: '/shop', label_i18n: { en: 'Shop' } },
        { id: 'not-of-this-menu', label: 'Om', url: '/about' },
      ],
    });
    expect(items().map((r) => r.id)).toEqual(['new-1', 'new-2']);
    expect(items()[0].label_i18n).toEqual({ en: 'Shop' });
    expect(items()[1].label_i18n).toEqual({});
  });
});

// M6: typed items and a depth cap of three levels.
describe('MenusService.setItems (M6 kind / resource_id / MENU_MAX_DEPTH)', () => {
  it('persists kind and resource_id; a CUSTOM item never keeps a resource_id', async () => {
    const { service, items } = build([]);
    await service.setItems('u1', 'm1', {
      items: [
        {
          label: 'Shop',
          url: '/collections/shop',
          kind: 'COLLECTION',
          resource_id: 'cat-1',
        },
        { label: 'Blog', url: 'https://x', resource_id: 'ignored' },
      ],
    });
    expect(items()[0]).toMatchObject({
      kind: 'COLLECTION',
      resource_id: 'cat-1',
    });
    expect(items()[1]).toMatchObject({ kind: 'CUSTOM', resource_id: null });
  });

  it('accepts three levels and rejects a fourth before touching the rows', async () => {
    const three = build([HOME]);
    await three.service.setItems('u1', 'm1', {
      items: [
        {
          label: 'L1',
          url: '/1',
          children: [
            { label: 'L2', url: '/2', children: [{ label: 'L3', url: '/3' }] },
          ],
        },
      ],
    });
    expect(three.items().map((r) => r.label)).toEqual(['L1', 'L2', 'L3']);

    const four = build([HOME]);
    await expect(
      four.service.setItems('u1', 'm1', {
        items: [
          {
            label: 'L1',
            url: '/1',
            children: [
              {
                label: 'L2',
                url: '/2',
                children: [
                  {
                    label: 'L3',
                    url: '/3',
                    children: [{ label: 'L4', url: '/4' }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).rejects.toMatchObject({ response: { code: 'MENU_MAX_DEPTH' } });
    const fourPrisma = four.prisma as { menuItem: { deleteMany: jest.Mock } };
    expect(fourPrisma.menuItem.deleteMany).not.toHaveBeenCalled();
    expect(four.items()).toEqual([HOME]);
  });
});
