import { ShippingMethodType } from '@prisma/client';
import { ShippingService, type ShippingMoney } from './shipping.service';
import { PrismaService } from '../../prisma/prisma.service';

// Markets app: POST /shipping/estimate on a market domain. Zones are priced
// in the base currency (SEK); the storefront sends its subtotal in the
// market currency (EUR) and must get the method costs back in EUR, with the
// free threshold compared in the base currency (same as POST /orders/quote).

const RATE = 0.087;
const money: ShippingMoney = {
  toBase: (a) => Math.round((a / RATE) * 100) / 100,
  fromBase: (a) => Math.round(a * RATE * 100) / 100,
};

function build() {
  const service = new ShippingService({} as unknown as PrismaService);
  const quote = jest.spyOn(service, 'quoteForItems').mockImplementation((dto) =>
    Promise.resolve({
      available: true,
      methods: [
        {
          id: 'std',
          name: 'Standard',
          type: ShippingMethodType.DELIVERY,
          // 69 kr, free from 400 kr (base currency).
          cost: dto.subtotal >= 400 ? 0 : 69,
          estimated_days: { min: 2, max: 4 },
          free_shipping: dto.subtotal >= 400,
        },
        {
          id: 'pickup',
          name: 'Pickup',
          type: ShippingMethodType.PICKUP,
          cost: 0,
          estimated_days: { min: 0, max: 0 },
          free_shipping: true,
        },
      ],
    }),
  );
  return { service, quote };
}

const dto = {
  product_ids: ['p1'],
  country_code: 'DE',
  item_count: 1,
  subtotal: 30,
};

describe('ShippingService.estimate with a market', () => {
  it('without money: base-currency subtotal and costs, unchanged', async () => {
    const { service, quote } = build();
    const out = await service.estimate(dto);
    expect(quote).toHaveBeenCalledWith(dto);
    expect(out).toMatchObject({
      cost: 0,
      methods: [{ cost: 69 }, { cost: 0 }],
    });
  });

  it('converts the subtotal to base and the costs to the market currency', async () => {
    const { service, quote } = build();
    const out = await service.estimate(
      { ...dto, store_id: 's1', market_key: 'eu' },
      money,
    );
    // €30 → 344.83 kr: below the 400 kr threshold.
    expect(quote.mock.calls[0][0]).toMatchObject({ ...dto, subtotal: 344.83 });
    expect(out).toMatchObject({ methods: [{ cost: 6 }, { cost: 0 }] });
  });

  it('applies the base-currency free threshold to a converted subtotal', async () => {
    const { service } = build();
    const out = await service.estimate({ ...dto, subtotal: 34.8 }, money);
    expect(out).toMatchObject({ methods: [{ cost: 0 }, { cost: 0 }] });
  });
});
