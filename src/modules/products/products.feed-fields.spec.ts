import { BadRequestException } from '@nestjs/common';
import { normalizeFeedFields } from './products.service';
import { PRODUCT_CONDITIONS } from './dto/product.dto';

// Feed data on the product DTOs (M5.6): trimming, clearing, GTIN check
// digit, X19 carry-over (absent key stays absent).
describe('products normalizeFeedFields (M5.6)', () => {
  it('trims, maps empty to null and leaves absent keys absent', () => {
    const data: Record<string, string | null> = {
      gtin: ' 4006381333931 ',
      mpn: '',
      brand: '  Namz ',
    };
    normalizeFeedFields(data);
    expect(data).toEqual({ gtin: '4006381333931', mpn: null, brand: 'Namz' });
    expect('google_product_category' in data).toBe(false);
    expect('condition' in data).toBe(false);
  });

  it('rejects a GTIN with a bad check digit', () => {
    expect(() => normalizeFeedFields({ gtin: '4006381333932' })).toThrow(
      BadRequestException,
    );
    try {
      normalizeFeedFields({ gtin: '12345' });
    } catch (err) {
      expect((err as BadRequestException).getResponse()).toMatchObject({
        code: 'PRODUCT_GTIN_INVALID',
      });
    }
  });

  it('stores condition "new" as null (the default) and keeps the others', () => {
    const a: Record<string, string | null> = { condition: 'new' };
    normalizeFeedFields(a);
    expect(a.condition).toBeNull();
    const b: Record<string, string | null> = { condition: 'refurbished' };
    normalizeFeedFields(b);
    expect(b.condition).toBe('refurbished');
    expect(PRODUCT_CONDITIONS).toEqual(['new', 'refurbished', 'used']);
  });
});
