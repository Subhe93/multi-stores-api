import {
  buildExternalRef,
  normalizeSiteHost,
  parseExternalRef,
  refFactory,
} from './external-ref';

describe('external refs (C7)', () => {
  it('builds woo:<host>:<kind>:<id>', () => {
    expect(buildExternalRef('namez.se', 'product', 2229)).toBe(
      'woo:namez.se:product:2229',
    );
    expect(buildExternalRef('NAMEZ.se', 'npp_template', '4273')).toBe(
      'woo:namez.se:npp_template:4273',
    );
    expect(refFactory('https://namez.se/')('product_cat', 176)).toBe(
      'woo:namez.se:product_cat:176',
    );
  });

  it('normalizes hosts and rejects junk', () => {
    expect(normalizeSiteHost('https://Namez.se:443/shop')).toBe('namez.se');
    expect(normalizeSiteHost('namez.se.')).toBe('namez.se');
    expect(() => normalizeSiteHost('')).toThrow();
    expect(() => normalizeSiteHost('na mez.se')).toThrow();
    expect(() => buildExternalRef('namez.se', 'product', 'a:b')).toThrow();
  });

  it('parses refs back', () => {
    expect(parseExternalRef('woo:namez.se:variation:2985')).toEqual({
      host: 'namez.se',
      kind: 'variation',
      id: '2985',
    });
    expect(parseExternalRef('woo:namez.se:unknown:1')).toBeNull();
    expect(parseExternalRef('wc:2229')).toBeNull();
    expect(
      parseExternalRef('woo:namez.se:product:' + '9'.repeat(200)),
    ).toBeNull();
  });
});
