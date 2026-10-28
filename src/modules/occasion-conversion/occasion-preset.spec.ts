import {
  HERO_HEADING_MAX,
  HERO_SUBHEADING_MAX,
  OCCASION_PRESET_KEYS,
  OCCASION_PRESET_TEXT,
  occasionPageSections,
  occasionPresetText,
} from './occasion-preset';

/**
 * Parity with the dashboard preset `occasion-page`
 * (multi-stores-dashboard/src/lib/section-presets.ts): same section keys in
 * the same order, same settings keys, and content under the schema's
 * translatable keys only (hero: eyebrow/heading/subheading/cta_*;
 * collection-products: heading/subheading/link_label; rich-text:
 * eyebrow/heading/html). Change both files together.
 */
describe('occasion preset', () => {
  const src = {
    name: 'Present till pappa',
    subheading: 'Kort text',
    hero_image: null,
    label_id: '11111111-1111-4111-8111-111111111111',
    html: '<p>SEO</p>',
    ...occasionPresetText('sv'),
  };

  it('emits the three sections in preset order with the dashboard settings keys', () => {
    const sections = occasionPageSections(src);
    expect(sections.map((s) => s.section_key)).toEqual([
      ...OCCASION_PRESET_KEYS,
    ]);
    expect(Object.keys(sections[0].settings).sort()).toEqual(
      ['alignment', 'height', 'layout', 'overlay_opacity'].sort(),
    );
    expect(Object.keys(sections[1].settings).sort()).toEqual(
      [
        'aspect',
        'category',
        'columns',
        'columns_mobile',
        'columns_tablet',
        'limit',
      ].sort(),
    );
    expect(Object.keys(sections[2].settings).sort()).toEqual(
      ['alignment', 'padding', 'surface', 'width'].sort(),
    );
    expect(sections[1].settings.category).toBe(src.label_id);
    expect(sections[1].settings.limit).toBe(12);
  });

  it('puts only translatable keys into content', () => {
    const [hero, products, text] = occasionPageSections(src);
    expect(Object.keys(hero.content)).toEqual(['heading', 'subheading']);
    expect(Object.keys(products.content)).toEqual(['heading', 'link_label']);
    expect(Object.keys(text.content)).toEqual(['heading', 'html']);
    expect(text.content.html).toBe('<p>SEO</p>');
  });

  it('adds the hero image only when present and clips long text', () => {
    const [hero] = occasionPageSections({
      ...src,
      hero_image: 'https://cdn/x.jpg',
    });
    expect(hero.settings.image).toBe('https://cdn/x.jpg');
    const [plain] = occasionPageSections({ ...src, subheading: null });
    expect(plain.settings.image).toBeUndefined();
    expect(plain.content.subheading).toBeUndefined();
    const long = occasionPageSections({
      ...src,
      name: 'x'.repeat(200),
      subheading: 'y'.repeat(400),
    })[0];
    expect((long.content.heading as string).length).toBe(HERO_HEADING_MAX);
    expect((long.content.subheading as string).length).toBe(
      HERO_SUBHEADING_MAX,
    );
  });

  it('omits the SEO block when there is no text', () => {
    const sections = occasionPageSections({ ...src, html: '  ' });
    expect(sections.map((s) => s.section_key)).toEqual([
      'hero-banner',
      'collection-products',
    ]);
  });

  it('has store-locale text for every supported locale, en as fallback', () => {
    for (const locale of ['en', 'ar', 'tr', 'de', 'fr', 'sv'])
      expect(OCCASION_PRESET_TEXT[locale]).toBeDefined();
    expect(occasionPresetText('xx')).toBe(OCCASION_PRESET_TEXT.en);
    expect(occasionPresetText('sv').products_link_label).toBe('Visa alla');
  });
});
