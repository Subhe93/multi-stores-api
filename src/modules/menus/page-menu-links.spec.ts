import {
  rewritePageMenuItems,
  syncPageMenuLinks,
  withPagePath,
} from './page-menu-links';
import { StorefrontService } from '../storefront/storefront.service';
import type { PrismaService } from '../../prisma/prisma.service';

// PAGE menu items follow their page's slug: rewritten on a slug change and
// resolved again when the storefront reads the menus.

const item = (
  id: string,
  kind: string,
  resource_id: string | null,
  url: string,
) => ({
  id,
  parent_id: null,
  kind,
  resource_id,
  url,
});

describe('withPagePath', () => {
  it('replaces the path and keeps a query / hash', () => {
    expect(withPagePath('/om-oss', 'om-namez')).toBe('/om-namez');
    expect(withPagePath('/om-oss#team', 'om-namez')).toBe('/om-namez#team');
    expect(withPagePath('/om-oss?a=1', 'om-namez')).toBe('/om-namez?a=1');
    expect(withPagePath(null, 'هدية')).toBe('/هدية');
  });
});

describe('rewritePageMenuItems', () => {
  it('points known PAGE items at the current slug; leaves the rest', () => {
    const items = [
      item('a', 'PAGE', 'p1', '/om-oss'),
      item('b', 'PAGE', 'gone', '/old'),
      item('c', 'CUSTOM', null, '/om-oss'),
      item('d', 'COLLECTION', 'p1', '/collections/x'),
    ];
    const out = rewritePageMenuItems(items, new Map([['p1', 'om-namez']]));
    expect(out.map((i) => i.url)).toEqual([
      '/om-namez',
      '/old',
      '/om-oss',
      '/collections/x',
    ]);
    expect(out[1]).toBe(items[1]);
  });
});

describe('syncPageMenuLinks', () => {
  it('updates only the stale PAGE rows of the store that link the page', async () => {
    const findMany = jest.fn(() =>
      Promise.resolve([
        { id: 'm1', url: '/om-oss' },
        { id: 'm2', url: '/om-namez' },
      ]),
    );
    const update = jest.fn(() => Promise.resolve({}));
    const n = await syncPageMenuLinks(
      { menuItem: { findMany, update } } as never,
      's1',
      'p1',
      'om-namez',
    );
    expect(n).toBe(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { kind: 'PAGE', resource_id: 'p1', menu: { store_id: 's1' } },
      select: { id: true, url: true },
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { url: '/om-namez' },
    });
  });
});

describe('StorefrontService.getMenus page links', () => {
  function storefront(prisma: Record<string, unknown>) {
    const svc = Object.create(StorefrontService.prototype) as StorefrontService;
    (svc as unknown as Record<string, unknown>).prisma =
      prisma as unknown as PrismaService;
    return svc;
  }

  it('serves PAGE items at the linked page slug (v2 and legacy)', async () => {
    const pageFind = jest.fn(() =>
      Promise.resolve([{ id: 'p1', slug: 'om-namez' }]),
    );
    const staticFind = jest.fn(() =>
      Promise.resolve([{ id: 'l1', slug: 'villkor' }]),
    );
    const svc = storefront({
      store: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 's1', creator_id: 'c1' }),
        ),
      },
      menu: {
        findMany: jest.fn(() =>
          Promise.resolve([
            {
              id: 'menu1',
              key: 'main',
              name: 'Main',
              items: [
                item('a', 'PAGE', 'p1', '/om-oss'),
                item('b', 'PAGE', 'l1', '/terms'),
                item('c', 'CUSTOM', null, '/om-oss'),
              ],
            },
          ]),
        ),
      },
      page: { findMany: pageFind },
      staticPage: { findMany: staticFind },
    });
    const [menu] = await svc.getMenus('namez');
    expect(menu.items.map((i) => i.url)).toEqual([
      '/om-namez',
      '/villkor',
      '/om-oss',
    ]);
    expect(pageFind).toHaveBeenCalledWith({
      where: { id: { in: ['p1', 'l1'] }, store_id: 's1', slug: { not: null } },
      select: { id: true, slug: true },
    });
  });

  it('makes no page query when no item links a page', async () => {
    const pageFind = jest.fn();
    const svc = storefront({
      store: {
        findUnique: jest.fn(() =>
          Promise.resolve({ id: 's1', creator_id: 'c1' }),
        ),
      },
      menu: {
        findMany: jest.fn(() =>
          Promise.resolve([
            {
              id: 'm',
              key: 'k',
              name: 'n',
              items: [item('c', 'CUSTOM', null, '/x')],
            },
          ]),
        ),
      },
      page: { findMany: pageFind },
      staticPage: { findMany: pageFind },
    });
    await svc.getMenus('namez');
    expect(pageFind).not.toHaveBeenCalled();
  });
});
