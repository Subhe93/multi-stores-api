import { buildList } from './__fixtures__/product-list-fake';

// Product-level stock of a product with variants (products/effective-stock):
// the storefront list serves the sum of the variants when every one carries
// a number, for own and for imported products. The fixture rows have one
// untracked variant (the golden list keeps the product number); here the
// rows read from Prisma are rewritten to all-numbered variants.

type AnyRow = Record<string, unknown> & {
  id: string;
  variants?: { stock_quantity: number | null }[];
  product?: {
    stock_quantity?: number | null;
    track_inventory?: boolean;
    variants: { stock_quantity: number | null }[];
  };
};

function withRows(
  rewriteOwn: (row: AnyRow) => AnyRow,
  rewriteCustom: (row: AnyRow) => AnyRow,
) {
  const built = buildList({
    own: [{ id: 'p-a', created: '2026-10-05T10:00:00Z', price: 300 }],
    custom: [{ id: 'cp-a', created: '2026-10-04T10:00:00Z', price: 210 }],
  });
  const prisma = built.prisma as unknown as {
    product: { findMany: (args: unknown) => Promise<AnyRow[]> };
    customProduct: { findMany: (args: unknown) => Promise<AnyRow[]> };
  };
  const ownFind = prisma.product.findMany;
  prisma.product.findMany = async (args) =>
    (await ownFind(args)).map((r) => rewriteOwn(structuredClone(r)));
  const customFind = prisma.customProduct.findMany;
  prisma.customProduct.findMany = async (args) =>
    (await customFind(args)).map((r) => rewriteCustom(structuredClone(r)));
  return built.service;
}

const byId = (list: unknown, id: string) =>
  (list as AnyRow[]).find((p) => p.id === id) as AnyRow;

describe('storefront list: product stock follows the variants', () => {
  it('all variants numbered: stock_quantity is their sum', async () => {
    const service = withRows(
      (row) => {
        row.variants![0].stock_quantity = 18;
        row.variants![1].stock_quantity = 20;
        return row;
      },
      (row) => {
        row.product!.track_inventory = true;
        row.product!.stock_quantity = 50;
        row.product!.variants[0].stock_quantity = 4;
        row.product!.variants[1].stock_quantity = 3;
        return row;
      },
    );
    const list = await service.getProducts('shop', {});
    // Own product: the row says 4, the variants hold 38.
    expect(byId(list, 'p-a').stock_quantity).toBe(38);
    // Imported product: the base row says 50, the variants hold 7.
    expect(byId(list, 'cp-a').stock_quantity).toBe(7);
    // Per-variant stock is untouched.
    expect(
      (byId(list, 'p-a').variants as unknown as { stock: number }[]).map(
        (v) => v.stock,
      ),
    ).toEqual([18, 20]);
  });

  it('one untracked variant: the product number is served unchanged', async () => {
    const service = withRows(
      (row) => row,
      (row) => {
        row.product!.track_inventory = true;
        row.product!.stock_quantity = 50;
        return row;
      },
    );
    const list = await service.getProducts('shop', {});
    expect(byId(list, 'p-a').stock_quantity).toBe(4);
    expect(byId(list, 'cp-a').stock_quantity).toBe(50);
  });

  it('no variants: the product number', async () => {
    const service = withRows(
      (row) => {
        row.variants = [];
        return row;
      },
      (row) => {
        row.product!.track_inventory = true;
        row.product!.stock_quantity = 9;
        row.product!.variants = [];
        return row;
      },
    );
    const list = await service.getProducts('shop', {});
    expect(byId(list, 'p-a').stock_quantity).toBe(4);
    expect(byId(list, 'cp-a').stock_quantity).toBe(9);
  });
});
