import {
  sanitizeAuthPagesConfig,
  stripBrandFromThemeConfig,
} from './theme-config';

describe('sanitizeAuthPagesConfig', () => {
  it('returns {} for non-object input', () => {
    expect(sanitizeAuthPagesConfig(undefined)).toEqual({});
    expect(sanitizeAuthPagesConfig(null)).toEqual({});
    expect(sanitizeAuthPagesConfig('x')).toEqual({});
    expect(sanitizeAuthPagesConfig([1])).toEqual({});
  });

  it('keeps valid values', () => {
    expect(
      sanitizeAuthPagesConfig({
        background_image: '/uploads/auth/bg.webp',
        background_color: '#FFE9A8',
        image_position: 'top',
        overlay_opacity: 20,
      }),
    ).toEqual({
      background_image: '/uploads/auth/bg.webp',
      background_color: '#FFE9A8',
      image_position: 'top',
      overlay_opacity: 20,
    });
    expect(
      sanitizeAuthPagesConfig({
        background_image: 'https://cdn.example.com/a.jpg',
      }),
    ).toEqual({ background_image: 'https://cdn.example.com/a.jpg' });
  });

  it('drops unknown keys and unsafe values', () => {
    expect(
      sanitizeAuthPagesConfig({
        background_image: 'javascript:alert(1)',
        background_color: 'red;background:url(x)',
        image_position: 'left',
        overlay_opacity: 'a',
        evil: 1,
      }),
    ).toEqual({});
    expect(
      sanitizeAuthPagesConfig({ background_image: '/a.jpg") ; x' }),
    ).toEqual({});
    expect(
      sanitizeAuthPagesConfig({ background_image: '//evil.com/a.jpg' }),
    ).toEqual({});
  });

  it('clamps and rounds the overlay opacity', () => {
    expect(sanitizeAuthPagesConfig({ overlay_opacity: 250 })).toEqual({
      overlay_opacity: 90,
    });
    expect(sanitizeAuthPagesConfig({ overlay_opacity: 12.6 })).toEqual({
      overlay_opacity: 13,
    });
    expect(sanitizeAuthPagesConfig({ overlay_opacity: 0 })).toEqual({});
  });
});

describe('stripBrandFromThemeConfig', () => {
  it('keeps the auth pages config when stripping brand keys', () => {
    expect(
      stripBrandFromThemeConfig({
        primaryColor: '#000',
        auth: { background_color: '#fff' },
      }),
    ).toEqual({ auth: { background_color: '#fff' } });
  });
});
