import { KITS } from './index';
import { substituteAssets } from './asset-substitution';

// Section keys registered in the storefront theme registry
// (multi-stores-web/src/themes/minimal/theme.ts). Kits may only reference
// these. Kept here as the API's contract with the theme; update both together.
const VALID_SECTION_KEYS = new Set([
  'hero-banner', 'hero-slider', 'rich-text', 'image-gallery', 'gallery-slider',
  'image-with-text', 'faq-list', 'call-to-action', 'trust-badges', 'testimonials',
  'logo-list', 'logo-marquee', 'sticky-cta-bar', 'stats-bar', 'feature-grid', 'steps',
  'comparison-table', 'countdown', 'video', 'spacer',
  'layout-columns', 'newsletter-signup', 'social-icons', 'featured-products',
  'product-slider', 'collection-products', 'product-page', 'product-gallery',
  'product-details', 'product-tabs', 'add-to-cart', 'header-bar', 'footer-columns',
  'copyright-bar', 'announcement-bar', 'mega-menu', 'mobile-bottom-nav',
]);

const ASSET_PREFIX = '@asset/';

// Collect every "@asset/<key>" reference found anywhere in a value.
function collectAssetRefs(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    if (value.startsWith(ASSET_PREFIX)) out.add(value.slice(ASSET_PREFIX.length));
  } else if (Array.isArray(value)) {
    value.forEach((v) => collectAssetRefs(v, out));
  } else if (value && typeof value === 'object') {
    Object.values(value).forEach((v) => collectAssetRefs(v, out));
  }
  return out;
}

describe('template kit catalog integrity', () => {
  it('has unique kit ids', () => {
    const ids = KITS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  describe.each(KITS.map((k) => [k.id, k] as const))('kit "%s"', (_id, kit) => {
    it('declares required catalog metadata', () => {
      expect(kit.name.en).toBeTruthy();
      expect(kit.description.en).toBeTruthy();
      expect(kit.themeKey).toBeTruthy();
      expect(kit.fallbackLocale).toBeTruthy();
      expect(kit.pages.length).toBeGreaterThan(0);
    });

    it('only references section keys registered in the theme', () => {
      for (const page of kit.pages) {
        for (const section of page.sections) {
          expect(VALID_SECTION_KEYS.has(section.section_key)).toBe(true);
        }
      }
    });

    it('resolves every @asset reference to a declared asset', () => {
      const declared = new Set(Object.keys(kit.assets));
      const refs = new Set<string>();
      collectAssetRefs(kit.previewImage, refs);
      for (const page of kit.pages) {
        for (const section of page.sections) {
          collectAssetRefs(section.settings, refs);
          collectAssetRefs(section.content, refs);
        }
      }
      if (kit.demoData) collectAssetRefs(kit.demoData, refs);

      const missing = [...refs].filter((r) => !declared.has(r));
      expect(missing).toEqual([]);
    });

    it('has a content entry for its own fallback locale on translatable sections', () => {
      // If a section ships `content`, it must at least cover the fallback locale
      // so every store locale resolves to something.
      for (const page of kit.pages) {
        for (const section of page.sections) {
          if (section.content && Object.keys(section.content).length > 0) {
            expect(section.content[kit.fallbackLocale]).toBeDefined();
          }
        }
      }
    });
  });

  it('substituteAssets replaces refs and blanks unmapped ones', () => {
    const input = { a: '@asset/known', b: ['@asset/missing', 'plain'], c: 1 };
    const out = substituteAssets(input, { known: '/uploads/x.jpg' });
    expect(out).toEqual({ a: '/uploads/x.jpg', b: ['', 'plain'], c: 1 });
  });
});
