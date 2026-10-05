import {
  emptyContentKeys,
  generateDefaultContent,
  planChromeSections,
  socialItems,
  THEME_MANAGED_KEY,
  type ExistingChromeSection,
} from './apply-chrome';
import type { ChromeSectionPreset } from './presets/types';

const section = (
  id: string,
  section_key: string,
  sort_order: number,
  settings: Record<string, unknown> = {},
  is_hidden = false,
): ExistingChromeSection => ({
  id,
  section_key,
  settings,
  sort_order,
  is_hidden,
});

describe('planChromeSections', () => {
  const preset: ChromeSectionPreset[] = [
    {
      section_key: 'announcement-bar',
      settings: { layout: 'rotating' },
      hidden_when_empty: true,
    },
    {
      section_key: 'header-bar',
      settings: { sticky_mode: 'always', show_account: true },
    },
  ];

  it('merges preset settings over existing ones, keeping extra keys', () => {
    const existing = [
      section('h1', 'header-bar', 0, {
        logo_url: '/uploads/logo.png',
        menu_key: 'main-nav',
        sticky_mode: 'none',
        show_account: false,
      }),
    ];
    const plan = planChromeSections(existing, preset);

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0]).toEqual({
      id: 'h1',
      sort_order: 1,
      settings: {
        logo_url: '/uploads/logo.png',
        menu_key: 'main-nav',
        sticky_mode: 'always',
        show_account: true,
      },
    });
  });

  it('preset keys win over existing values', () => {
    const existing = [section('h1', 'header-bar', 0, { sticky_mode: 'none' })];
    const plan = planChromeSections(existing, preset);
    expect(plan.updates[0].settings.sticky_mode).toBe('always');
  });

  it('creates sections the page lacks, at the preset position', () => {
    const existing = [section('h1', 'header-bar', 0)];
    const plan = planChromeSections(existing, preset);

    expect(plan.creates).toEqual([
      {
        section_key: 'announcement-bar',
        // Created sections carry the marker so a later preset may hide them.
        settings: { layout: 'rotating', [THEME_MANAGED_KEY]: true },
        sort_order: 0,
        hidden: false,
      },
    ]);
    expect(plan.updates[0].sort_order).toBe(1);
  });

  it('creates hidden only when hidden_when_empty and the key is empty', () => {
    const empty = new Set(['announcement-bar', 'header-bar']);
    const plan = planChromeSections([], preset, empty);
    const byKey = Object.fromEntries(
      plan.creates.map((c) => [c.section_key, c]),
    );
    expect(byKey['announcement-bar'].hidden).toBe(true);
    // header-bar has no hidden_when_empty flag → never hidden.
    expect(byKey['header-bar'].hidden).toBe(false);
  });

  it('keeps unrelated sections untouched and re-sorts them after the preset ones', () => {
    const existing = [
      section('s1', 'social-icons', 0, { layout: 'grid' }, true),
      section('h1', 'header-bar', 1),
      section('r1', 'rich-text', 2),
    ];
    const plan = planChromeSections(existing, preset);

    // Only header-bar is updated; social-icons / rich-text are not touched.
    expect(plan.updates.map((u) => u.id)).toEqual(['h1']);
    expect(plan.creates.map((c) => c.section_key)).toEqual([
      'announcement-bar',
    ]);
    // Preset occupies 0..1, the rest follow in their previous relative order.
    expect(plan.untouchedSortOrders).toEqual([
      { id: 's1', sort_order: 2 },
      { id: 'r1', sort_order: 3 },
    ]);
  });

  it('updates only the first of two sections sharing a key', () => {
    const existing = [
      section('h-first', 'header-bar', 0, { logo_size: 48 }),
      section('h-second', 'header-bar', 1, { logo_size: 24 }),
    ];
    const plan = planChromeSections(existing, preset);

    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].id).toBe('h-first');
    expect(plan.updates[0].settings).toEqual({
      logo_size: 48,
      sticky_mode: 'always',
      show_account: true,
    });
    // The duplicate is kept as is and sorted after the preset sections.
    expect(plan.untouchedSortOrders).toEqual([
      { id: 'h-second', sort_order: 2 },
    ]);
    expect(plan.creates.map((c) => c.section_key)).toEqual([
      'announcement-bar',
    ]);
  });

  it('picks "first" by sort_order, not array position', () => {
    const existing = [
      section('later', 'header-bar', 5),
      section('earlier', 'header-bar', 2),
    ];
    const plan = planChromeSections(existing, preset);
    expect(plan.updates[0].id).toBe('earlier');
  });

  it('never deletes: every existing id appears in updates or untouched', () => {
    const existing = [
      section('a', 'copyright-bar', 0),
      section('b', 'header-bar', 1),
      section('c', 'header-bar', 2),
      section('d', 'spacer', 3),
    ];
    const plan = planChromeSections(existing, preset);
    const ids = [
      ...plan.updates.map((u) => u.id),
      ...plan.untouchedSortOrders.map((u) => u.id),
    ].sort();
    expect(ids).toEqual(['a', 'b', 'c', 'd']);
  });

  it('drops colour overrides a previous preset left when the new one does not set them', () => {
    const existing = [
      section('h', 'header-bar', 0, {
        bg_color: '#0a0a0a',
        text_color: '#fff',
        logo_url: '/logo.svg',
      }),
    ];
    const plan = planChromeSections(existing, [
      {
        section_key: 'header-bar',
        settings: { sticky_mode: 'always', accent_color: '#f00' },
      },
    ]);
    expect(plan.updates[0].settings).toEqual({
      logo_url: '/logo.svg',
      sticky_mode: 'always',
      accent_color: '#f00',
    });
  });

  it('marks created sections as theme-managed and hides them when a later preset drops them', () => {
    const first = planChromeSections(
      [],
      [{ section_key: 'mega-menu', settings: { alignment: 'center' } }],
    );
    expect(first.creates[0].settings[THEME_MANAGED_KEY]).toBe(true);

    const existing = [
      section('m', 'mega-menu', 0, first.creates[0].settings),
      section('c', 'custom-banner', 1, { layout: 'x' }),
    ];
    const later = planChromeSections(existing, [
      { section_key: 'header-bar', settings: {} },
    ]);
    const managed = later.untouchedSortOrders.find((u) => u.id === 'm');
    const authored = later.untouchedSortOrders.find((u) => u.id === 'c');
    expect(managed?.is_hidden).toBe(true);
    expect(authored?.is_hidden).toBeUndefined();
  });

  it('shows a theme-managed section again when a preset uses it', () => {
    const existing = [
      section('m', 'mega-menu', 3, { [THEME_MANAGED_KEY]: true }, true),
    ];
    const plan = planChromeSections(existing, [
      { section_key: 'mega-menu', settings: { alignment: 'start' } },
    ]);
    expect(plan.updates[0].is_hidden).toBe(false);
    const hiddenWhenEmpty = planChromeSections(
      [
        section(
          'a',
          'announcement-bar',
          0,
          { [THEME_MANAGED_KEY]: true },
          true,
        ),
      ],
      [
        {
          section_key: 'announcement-bar',
          settings: {},
          hidden_when_empty: true,
        },
      ],
      new Set(['announcement-bar']),
    );
    expect(hiddenWhenEmpty.updates[0].is_hidden).toBe(true);
  });

  it('does not mutate the inputs', () => {
    const existingSettings = { sticky_mode: 'none' };
    const existing = [section('h1', 'header-bar', 0, existingSettings)];
    planChromeSections(existing, preset);
    expect(existingSettings).toEqual({ sticky_mode: 'none' });
    expect(preset[1].settings).toEqual({
      sticky_mode: 'always',
      show_account: true,
    });
  });
});

describe('generateDefaultContent', () => {
  it('header-bar yields localized Home / Products / Collections links', () => {
    const en = generateDefaultContent('header-bar', 'en');
    expect(en.meaningful).toBe(true);
    expect(en.content.items).toEqual([
      { label: 'Home', url: '/' },
      { label: 'Products', url: '/products' },
      { label: 'Collections', url: '/collections' },
    ]);

    const ar = generateDefaultContent('header-bar', 'ar');
    expect((ar.content.items as { label: string }[])[0].label).toBe('الرئيسية');
  });

  it('falls back to English for unknown locales', () => {
    const xx = generateDefaultContent('header-bar', 'xx');
    expect((xx.content.items as { label: string }[])[1].label).toBe('Products');
  });

  it('announcement-bar never invents messages and is not meaningful', () => {
    const out = generateDefaultContent('announcement-bar', 'en');
    expect(out).toEqual({ content: { messages: [] }, meaningful: false });
  });

  it('footer-columns yields Shop / Help / Store columns with legal links', () => {
    const out = generateDefaultContent('footer-columns', 'de');
    const columns = out.content.columns as {
      heading: string;
      links: { label: string; url: string }[];
    }[];
    expect(out.meaningful).toBe(true);
    expect(columns.map((c) => c.heading)).toEqual([
      'Einkaufen',
      'Hilfe',
      'Shop',
    ]);
    expect(columns[1].links.map((l) => l.url)).toEqual([
      '/legal/shipping',
      '/legal/refund',
      '/account/orders',
    ]);
    expect(columns[2].links.map((l) => l.url)).toEqual([
      '/legal/terms',
      '/legal/privacy',
    ]);
  });

  it('social-icons reads non-empty store socials and is empty otherwise', () => {
    const none = generateDefaultContent('social-icons', 'en', { socials: {} });
    expect(none).toEqual({ content: { items: [] }, meaningful: false });

    const some = generateDefaultContent('social-icons', 'en', {
      socials: {
        instagram: 'https://instagram.com/shop',
        facebook: '   ',
        tiktok: undefined,
        twitter: 'https://x.com/shop',
      },
    });
    expect(some.meaningful).toBe(true);
    expect(some.content.items).toEqual([
      { platform: 'instagram', url: 'https://instagram.com/shop' },
      { platform: 'twitter', url: 'https://x.com/shop' },
    ]);
  });

  it('copyright-bar uses the {year}/{store} tokens and no payment labels', () => {
    const out = generateDefaultContent('copyright-bar', 'fr');
    expect(out.content).toEqual({
      text: '© {year} {store}. Tous droits réservés.',
      payment_methods: [],
    });
    expect(out.meaningful).toBe(true);
  });

  it('mobile-bottom-nav and mega-menu use the storefront content shapes', () => {
    const nav = generateDefaultContent('mobile-bottom-nav', 'en');
    expect(nav.content.items).toEqual([
      { type: 'home' },
      { type: 'search' },
      { type: 'categories' },
      { type: 'cart' },
    ]);
    const mega = generateDefaultContent('mega-menu', 'sv');
    expect((mega.content.triggers as { label: string }[])[0].label).toBe(
      'Startsida',
    );
  });

  it('unknown sections yield empty, non-meaningful content', () => {
    expect(generateDefaultContent('hero-banner', 'en')).toEqual({
      content: {},
      meaningful: false,
    });
  });
});

describe('emptyContentKeys', () => {
  it('lists the preset keys whose generated content is empty', () => {
    const preset: ChromeSectionPreset[] = [
      {
        section_key: 'announcement-bar',
        settings: {},
        hidden_when_empty: true,
      },
      { section_key: 'header-bar', settings: {} },
      { section_key: 'social-icons', settings: {}, hidden_when_empty: true },
    ];
    expect([...emptyContentKeys(preset, { socials: null })].sort()).toEqual([
      'announcement-bar',
      'social-icons',
    ]);
    expect([
      ...emptyContentKeys(preset, {
        socials: { youtube: 'https://youtube.com/@s' },
      }),
    ]).toEqual(['announcement-bar']);
  });
});

describe('socialItems', () => {
  it('ignores non-string and blank values and keeps a stable order', () => {
    expect(
      socialItems({
        youtube: 'https://youtube.com/@s',
        instagram: 42,
        facebook: '',
        tiktok: 'tiktok.com/@s',
      }),
    ).toEqual([
      { platform: 'tiktok', url: 'tiktok.com/@s' },
      { platform: 'youtube', url: 'https://youtube.com/@s' },
    ]);
    expect(socialItems(null)).toEqual([]);
  });
});
