import { keepOwnerSettings } from './keep-owner-css';

describe('keepOwnerSettings', () => {
  it('keeps custom CSS, motion and product.card; drops look tokens', () => {
    expect(
      keepOwnerSettings({
        colors: { primary: '#000' },
        customCss: 'a{}',
        motion: { reveal: 'off' },
        product: { swatchShape: 'square', card: { x: 1 } },
      }),
    ).toEqual({
      customCss: 'a{}',
      motion: { reveal: 'off' },
      product: { card: { x: 1 } },
    });
  });

  it('gives nothing for empty, malformed or look-only values', () => {
    for (const prev of [
      { motion: {} },
      { motion: [] },
      { product: { swatchShape: 'square' } },
      { product: { card: null } },
      { product: [] },
      { motion: 'fast' },
      null,
      undefined,
      'x',
      [],
      {},
    ]) {
      expect(keepOwnerSettings(prev)).toEqual({});
    }
  });

  it('keeps the filtered listing setting, even empty (on with defaults)', () => {
    expect(
      keepOwnerSettings({ colors: { primary: '#000' }, listing: {} }),
    ).toEqual({ listing: {} });
    expect(
      keepOwnerSettings({ listing: { filters: ['size'], density: 3 } }),
    ).toEqual({ listing: { filters: ['size'], density: 3 } });
    for (const listing of [null, [], 'on', true]) {
      expect(keepOwnerSettings({ listing })).toEqual({});
    }
  });

  it('keeps each key independently', () => {
    expect(keepOwnerSettings({ motion: { reveal: 'off' } })).toEqual({
      motion: { reveal: 'off' },
    });
    expect(keepOwnerSettings({ product: { card: false } })).toEqual({
      product: { card: false },
    });
    expect(keepOwnerSettings({ customCss: 'b{}', preset_id: 'x' })).toEqual({
      customCss: 'b{}',
    });
  });
});
