import { FulfillerType, TaxPricingMode } from '@prisma/client';
import { providerOrderShare } from './orders.service';

// The provider order detail shows the provider's OWN share of the aggregate
// provider_amount (the transfers' largest-remainder split) and the net
// shipping, so the breakdown adds up on multi-provider orders.

const order = {
  currency: 'EUR',
  total: 59.9,
  tax_amount: 11.98,
  shipping_cost: 9.9,
  shipping_tax_amount: 1.98,
  tax_pricing_mode: TaxPricingMode.INCLUSIVE,
  commission: { provider_amount: 25.51 },
  items: [
    {
      fulfiller_type: FulfillerType.PROVIDER,
      fulfiller_id: 'prov-b',
      provider_base_amount: 10,
    },
    {
      fulfiller_type: FulfillerType.PROVIDER,
      fulfiller_id: 'prov-a',
      provider_base_amount: 10,
    },
    {
      fulfiller_type: FulfillerType.CREATOR,
      fulfiller_id: 'cr1',
      provider_base_amount: 0,
    },
  ],
};

describe('providerOrderShare', () => {
  it('each provider gets its transfer share; the shares add up', () => {
    const a = providerOrderShare(order, 'prov-a');
    const b = providerOrderShare(order, 'prov-b');
    expect(a.my_share).toBe(12.76);
    expect(b.my_share).toBe(12.75);
    expect(Math.round(((a.my_share ?? 0) + (b.my_share ?? 0)) * 100)).toBe(
      2551,
    );
  });

  it('net shipping is the shipping without its VAT', () => {
    expect(providerOrderShare(order, 'prov-a').net_shipping).toBe(7.92);
    expect(
      providerOrderShare(
        { ...order, tax_pricing_mode: TaxPricingMode.EXCLUSIVE },
        'prov-a',
      ).net_shipping,
    ).toBe(9.9);
  });

  it('no commission row yet: my_share is null', () => {
    expect(
      providerOrderShare({ ...order, commission: null }, 'prov-a').my_share,
    ).toBeNull();
  });
});
