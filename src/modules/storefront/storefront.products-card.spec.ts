import {
  CARD_CONFIG,
  buildList,
  type ListFixture,
} from './__fixtures__/product-list-fake';

// GET /storefront/:slug/products?card=1: opt-in data of the enhanced product
// card. Without the exact value `1` the answer and the Prisma reads are the
// documented ones; with it each row only gains fields.

const COLOUR_CONFIG = [{ name: 'color', values: ['Red', 'Blue'] }];

function fixture(): ListFixture {
  return {
    own: [
      { id: 'p-a', created: '2026-10-05T10:00:00Z', price: 300 },
      {
        id: 'p-b',
        created: '2026-10-04T10:00:00Z',
        price: 120,
        optionConfig: CARD_CONFIG,
      },
    ],
    custom: [
      { id: 'cp-a', created: '2026-10-06T10:00:00Z', price: 210 },
      {
        id: 'cp-b',
        created: '2026-10-03T10:00:00Z',
        price: 0,
        pricing: 'PER_VARIANT',
      },
    ],
    promotions: [{ id: 'promo-all', type: 'PERCENTAGE', value: 10 }],
    personalization: false,
  };
}

type Row = Record<string, unknown> & { id: string };
type Include = {
  images?: { take: number };
  mockup_images?: { take: number };
  product?: { include: { images: { take: number } } };
};
type FindArgs = { include?: Include };
const includeOf = (args: unknown) => (args as FindArgs | undefined)?.include;

/**
 * The list fake ignores a nested `take`, so the image tables are emulated
 * here: every row owns three images and the include's `take` cuts them. The
 * base product of a custom row also gets the two fields the card reads.
 */
function build() {
  const built = buildList(fixture());
  const { prisma } = built;
  const image = (id: string, n: number) => ({
    id: `${id}-i${n}`,
    url: `/uploads/${id}-${n}.webp`,
    alt_text: null,
    sort_order: n,
    is_featured: n === 0,
  });
  const three = (id: string) => [0, 1, 2].map((n) => image(id, n));

  const own = prisma.product.findMany.getMockImplementation()!;
  prisma.product.findMany.mockImplementation(async (args) => {
    const rows = (await own(args)) as Row[];
    const take = includeOf(args)?.images?.take;
    if (take === undefined) return rows;
    return rows.map((r) => ({ ...r, images: three(r.id).slice(0, take) }));
  });

  const custom = prisma.customProduct.findMany.getMockImplementation()!;
  prisma.customProduct.findMany.mockImplementation(async (args) => {
    const rows = (await custom(args)) as Row[];
    const include = includeOf(args);
    if (!include) return rows;
    const mockTake = include.mockup_images!.take;
    const baseTake = include.product!.include.images.take;
    return rows.map((r) => ({
      ...r,
      // cp-a has mockups; cp-b falls back to the base product images.
      mockup_images:
        r.id === 'cp-a'
          ? [0, 1, 2]
              .map((n) => ({
                id: `${r.id}-m${n}`,
                url: `/uploads/${r.id}-m${n}.webp`,
                sort_order: n,
              }))
              .slice(0, mockTake)
          : [],
      product: {
        ...(r.product as Row),
        images: three(`base-${r.id}`).slice(0, baseTake),
        track_inventory: true,
        stock_quantity: 7,
        compare_at_price: r.id === 'cp-a' ? 260 : null,
        variant_option_config: r.id === 'cp-a' ? COLOUR_CONFIG : CARD_CONFIG,
      },
    }));
  });
  return built;
}

const rowsOf = (answer: unknown): Row[] =>
  (Array.isArray(answer)
    ? answer
    : (answer as { items: Row[] }).items) as Row[];
const byId = (answer: unknown) => new Map(rowsOf(answer).map((r) => [r.id, r]));
const urls = (row: Row) => (row.images as { url: string }[]).map((i) => i.url);
const includesOf = (mock: jest.Mock) =>
  (mock.mock.calls as [unknown][])
    .map(([a]) => includeOf(a))
    .filter((i): i is Include => !!i);

const MODES: [string, Record<string, unknown>][] = [
  ['full list', {}],
  ['limit', { limit: '10' }],
  ['page', { page: '1', limit: '10' }],
];

describe('products list without card=1 is unchanged', () => {
  it.each(MODES)('%s: same bytes and same reads', async (_n, filters) => {
    const plain = build();
    const expected = JSON.stringify(
      await plain.service.getProducts('shop', filters),
    );
    // Any value but the exact string '1' is ignored.
    for (const card of ['0', 'true', '', ' 1', '11', 1, ['1'], null]) {
      const other = build();
      const answer = await other.service.getProducts('shop', {
        ...filters,
        card,
      });
      expect(JSON.stringify(answer)).toBe(expected);
      expect(JSON.stringify(other.prisma.product.findMany.mock.calls)).toBe(
        JSON.stringify(plain.prisma.product.findMany.mock.calls),
      );
      expect(
        JSON.stringify(other.prisma.customProduct.findMany.mock.calls),
      ).toBe(JSON.stringify(plain.prisma.customProduct.findMany.mock.calls));
    }
    // One image per row, and no card field on a custom row.
    for (const inc of includesOf(plain.prisma.product.findMany))
      expect(inc.images!.take).toBe(1);
    for (const inc of includesOf(plain.prisma.customProduct.findMany)) {
      expect(inc.mockup_images!.take).toBe(1);
      expect(inc.product!.include.images.take).toBe(1);
    }
    const rows = byId(JSON.parse(expected));
    expect(rows.get('p-a')!.images).toHaveLength(1);
    expect(rows.get('cp-a')!.images).toHaveLength(1);
    expect(rows.get('cp-a')).not.toHaveProperty('variant_option_config');
    expect(rows.get('cp-a')).not.toHaveProperty('compare_at_price');
  });
});

describe('products list with card=1', () => {
  it.each(MODES)('%s: rows only gain the card fields', async (_n, filters) => {
    const plain = build();
    const before = JSON.parse(
      JSON.stringify(await plain.service.getProducts('shop', filters)),
    ) as unknown;
    const { service, prisma } = build();
    const answer = JSON.parse(
      JSON.stringify(
        await service.getProducts('shop', { ...filters, card: '1' }),
      ),
    ) as unknown;

    // Reads: two images per source, everything else as the default include.
    for (const inc of includesOf(prisma.product.findMany))
      expect(inc.images!.take).toBe(2);
    for (const inc of includesOf(prisma.customProduct.findMany)) {
      expect(inc.mockup_images!.take).toBe(2);
      expect(inc.product!.include.images.take).toBe(2);
    }

    // Same rows in the same order; the envelope of a page is unchanged.
    expect(rowsOf(answer).map((r) => r.id)).toEqual(
      rowsOf(before).map((r) => r.id),
    );
    expect(Array.isArray(answer)).toBe(Array.isArray(before));
    if (!Array.isArray(answer))
      expect({ ...(answer as object), items: null }).toEqual({
        ...(before as object),
        items: null,
      });

    const was = byId(before);
    const now = byId(answer);
    const added = new Set(['variant_option_config', 'compare_at_price']);
    for (const [id, row] of now) {
      const old = was.get(id)!;
      // Nothing removed or reordered: the old keys keep their order.
      expect(Object.keys(row).filter((k) => k in old)).toEqual(
        Object.keys(old),
      );
      const extra = Object.keys(row).filter((k) => !(k in old));
      expect(extra.every((k) => added.has(k))).toBe(true);
      // Every old value but `images` is identical.
      expect({ ...row, images: null }).toMatchObject({ ...old, images: null });
      // The first image is the one the default list sends.
      expect(urls(row)[0]).toBe(urls(old)[0]);
    }

    // Own rows: two images, the option config still shaped for the store.
    expect(urls(now.get('p-a')!)).toEqual([
      '/uploads/p-a-0.webp',
      '/uploads/p-a-1.webp',
    ]);
    expect(Object.keys(now.get('p-a')!)).toEqual(Object.keys(was.get('p-a')!));
    expect(now.get('p-b')!.variant_option_config).toEqual(
      was.get('p-b')!.variant_option_config,
    );
    expect(now.get('p-a')!).not.toHaveProperty('cost_price');

    // Custom row with mockups: two mockups, base config and compare price.
    const cpA = now.get('cp-a')!;
    expect(urls(cpA)).toEqual([
      '/uploads/cp-a-m0.webp',
      '/uploads/cp-a-m1.webp',
    ]);
    expect(cpA.variant_option_config).toEqual(COLOUR_CONFIG);
    expect(cpA.compare_at_price).toBe(260);
    expect(cpA.track_inventory).toBe(true);

    // Custom row without mockups: two base images; the advanced config is
    // shaped as on the product page (no valueMeta, card shown as text) and
    // an empty compare-at price is absent.
    const cpB = now.get('cp-b')!;
    expect(urls(cpB)).toEqual([
      '/uploads/base-cp-b-0.webp',
      '/uploads/base-cp-b-1.webp',
    ]);
    const shaped = cpB.variant_option_config as Record<string, unknown>[];
    expect(shaped).toHaveLength(1);
    expect(shaped[0]).not.toHaveProperty('valueMeta');
    expect(shaped[0].style).not.toBe('card');
    expect(shaped[0].values).toEqual(['1', '2']);
    expect(cpB).not.toHaveProperty('compare_at_price');
  });
});
