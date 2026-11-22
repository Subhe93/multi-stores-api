import { buildOrderCreate } from './__fixtures__/order-create.harness';

// M159: an order line keeps the canonical `variant_options_snapshot` and
// gets `variant_options_display` (buyer language) only when a label differs.

const DE = {
  names: { Färg: 'Farbe' },
  values: { Färg: { Svart: 'Schwarz' } },
};

function harness() {
  return buildOrderCreate({
    products: {
      p1: {
        creator_id: 'c1',
        provider_id: null,
        base_price: 100,
        track_inventory: false,
        stock_quantity: null,
      },
    },
    variants: {
      v1: {
        product_id: 'p1',
        stock_quantity: null,
        options: { Färg: 'Svart', Storlek: 'M' },
      },
    },
    optionLabels: { p1: { de: DE } },
  });
}

type CreatedItem = Record<string, unknown>;
const itemsOf = (order: unknown) => (order as { items: CreatedItem[] }).items;
const line = { product_id: 'p1', variant_id: 'v1', quantity: 1 };

describe('OrdersService.create variant_options_display (M159)', () => {
  it('writes the buyer-language snapshot next to the canonical one', async () => {
    const h = harness();
    const [item] = itemsOf(await h.place([line], { locale: 'de' }));
    expect(item.variant_options_snapshot).toEqual({
      Färg: 'Svart',
      Storlek: 'M',
    });
    expect(item.variant_options_display).toEqual({
      locale: 'de',
      entries: [
        {
          name: 'Färg',
          value: 'Svart',
          name_label: 'Farbe',
          value_label: 'Schwarz',
        },
        {
          name: 'Storlek',
          value: 'M',
          name_label: 'Storlek',
          value_label: 'M',
        },
      ],
    });
  });

  it('base language: de-AT uses the de labels', async () => {
    const h = harness();
    const [item] = itemsOf(await h.place([line], { locale: 'de-AT' }));
    expect(item.variant_options_display).toMatchObject({ locale: 'de-AT' });
  });

  it('primary locale or no labels: the key is absent (no read)', async () => {
    const h = harness();
    const [sv] = itemsOf(await h.place([line], { locale: 'sv' }));
    expect('variant_options_display' in sv).toBe(false);
    const [en] = itemsOf(await h.place([line], { locale: 'en' }));
    expect('variant_options_display' in en).toBe(false);
    const [none] = itemsOf(await h.place([line]));
    expect('variant_options_display' in none).toBe(false);
    expect(h.prisma.productTranslation.findMany).toHaveBeenCalledTimes(1);
  });
});
