import { StoreType } from '@prisma/client';
import { buildOrderCreate } from './__fixtures__/order-create.harness';

// Owner's rule: no cash on delivery in MARKETPLACE stores at all. The order
// gate reads the effective flag (stores/cod-policy.ts), so a `true` left on
// a marketplace row does not open COD. INDEPENDENT stores are unchanged.
// The harness store row always carries cod_enabled: true.

// A fresh catalogue per order: the harness mutates the stock rows in place.
const catalogue = () => ({
  products: {
    p1: {
      creator_id: 'c1',
      provider_id: null,
      track_inventory: true,
      stock_quantity: 5,
    },
  },
});

const placeCod = (storeType: StoreType) => {
  const h = buildOrderCreate({ ...catalogue(), storeType });
  const run = h.service.create(
    'u1',
    { address_id: 'a1', store_id: 's1', payment_method: 'COD' } as never,
    {
      lines: [{ product_id: 'p1', variant_id: null, quantity: 1 }],
    } as never,
  );
  return { h, run };
};

describe('COD order gate by store type', () => {
  it('a MARKETPLACE store refuses a COD order with ORDER_COD_DISABLED', async () => {
    const { h, run } = placeCod(StoreType.MARKETPLACE);
    await expect(run).rejects.toMatchObject({
      response: { code: 'ORDER_COD_DISABLED' },
    });
    // Nothing was taken from stock.
    expect(h.products.get('p1')?.stock_quantity).toBe(5);
  });

  it('a MARKETPLACE store with no payment method named (COD default) is refused too', async () => {
    const h = buildOrderCreate({
      ...catalogue(),
      storeType: StoreType.MARKETPLACE,
    });
    await expect(
      h.service.create(
        'u1',
        { address_id: 'a1', store_id: 's1' } as never,
        {
          lines: [{ product_id: 'p1', variant_id: null, quantity: 1 }],
        } as never,
      ),
    ).rejects.toMatchObject({ response: { code: 'ORDER_COD_DISABLED' } });
  });

  it('a MARKETPLACE store still takes a card order', async () => {
    const h = buildOrderCreate({
      ...catalogue(),
      storeType: StoreType.MARKETPLACE,
    });
    await expect(
      h.place([{ product_id: 'p1', variant_id: null, quantity: 1 }]),
    ).resolves.toBeDefined();
    expect(h.products.get('p1')?.stock_quantity).toBe(4);
  });

  it('an INDEPENDENT store with COD on takes a COD order as before', async () => {
    const { h, run } = placeCod(StoreType.INDEPENDENT);
    await expect(run).resolves.toBeDefined();
    expect(h.products.get('p1')?.stock_quantity).toBe(4);
  });
});
