import { THEME_PRESETS, findPreset, listPresetSummaries } from './presets';
import type { ChromeSectionPreset } from './presets/types';

// Chrome section keys registered in the storefront theme registry that a
// look preset may reference. Kept in sync with the storefront definitions in
// multi-stores-web/src/themes/minimal/sections/chrome/*.tsx + SocialIcons.
const CHROME_SECTION_KEYS: Record<string, ReadonlySet<string>> = {
  'announcement-bar': new Set([
    'layout',
    'rotate_ms',
    'marquee_speed_s',
    'dismissible',
    'dismiss_key',
    'bg_color',
    'text_color',
    'link_color',
  ]),
  'header-bar': new Set([
    'show_logo',
    'show_store_name',
    'logo_size',
    'show_search',
    'show_cart',
    'cart_action',
    'show_account',
    'show_locale',
    'sticky_mode',
    'bg_color',
    'text_color',
    'border_color',
    'accent_color',
  ]),
  'mega-menu': new Set([
    'alignment',
    'bg_color',
    'text_color',
    'panel_bg_color',
    'panel_text_color',
    'accent_color',
    'border_color',
  ]),
  'mobile-bottom-nav': new Set([
    'show_labels',
    'bg_color',
    'text_color',
    'active_color',
    'border_color',
  ]),
  'footer-columns': new Set([
    'bg_color',
    'text_color',
    'heading_color',
    'link_color',
  ]),
  'social-icons': new Set([
    'layout',
    'alignment',
    'gap_px',
    'icon_style',
    'icon_shape',
    'size',
    'size_px',
    'color_mode',
    'custom_color',
    'custom_bg_color',
    'label_mode',
    'hover_effect',
    'open_in_new_tab',
    'nofollow',
    'heading_color',
    'subheading_color',
  ]),
  'copyright-bar': new Set([
    'alignment',
    'show_payment_icons',
    'bg_color',
    'text_color',
    'border_color',
  ]),
};

const HEADER_KEYS = new Set([
  'announcement-bar',
  'header-bar',
  'mega-menu',
  'mobile-bottom-nav',
  'social-icons',
]);
const FOOTER_KEYS = new Set([
  'footer-columns',
  'social-icons',
  'copyright-bar',
  'mobile-bottom-nav',
]);

// Settings keys that would carry creator content rather than look.
const CONTENT_LIKE_KEYS = new Set([
  'logo_url',
  'logo_url_mobile',
  'store_name_override',
  'menu_key',
  'items',
  'messages',
  'columns',
  'triggers',
  'text',
  'payment_methods',
  'heading',
  'subheading',
]);

const HEX = /^#[0-9a-f]{6}$/i;

function sections(p: {
  header: ChromeSectionPreset[];
  footer: ChromeSectionPreset[];
}) {
  return [...p.header, ...p.footer];
}

describe('theme presets catalog', () => {
  it('has six presets with unique ids', () => {
    expect(THEME_PRESETS).toHaveLength(6);
    const ids = THEME_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('findPreset resolves by id and misses unknown ids', () => {
    expect(findPreset('market-fresh')?.id).toBe('market-fresh');
    expect(findPreset('nope')).toBeUndefined();
  });

  it('summaries carry only the lightweight fields', () => {
    const summaries = listPresetSummaries();
    expect(summaries).toHaveLength(THEME_PRESETS.length);
    for (const s of summaries) {
      expect(Object.keys(s).sort()).toEqual(
        [
          'base_theme_key',
          'chrome',
          'description',
          'fonts',
          'id',
          'name',
          'swatch',
          'tags',
        ].sort(),
      );
    }
  });

  describe.each(THEME_PRESETS.map((p) => [p.id, p] as const))(
    '%s',
    (_id, preset) => {
      it('has en + ar name and description', () => {
        for (const field of [preset.name, preset.description]) {
          expect(field.en?.trim()).toBeTruthy();
          expect(field.ar?.trim()).toBeTruthy();
        }
        expect(preset.tags.length).toBeGreaterThan(0);
      });

      it('targets a known base theme', () => {
        expect(['minimal', 'bold', 'classic']).toContain(preset.base_theme_key);
      });

      it('has six hex swatch colours that match its colour tokens', () => {
        const keys = [
          'primary',
          'secondary',
          'accent',
          'background',
          'surface',
          'text',
        ];
        expect(Object.keys(preset.swatch).sort()).toEqual([...keys].sort());
        const colors = (
          preset.theme_customizations as { colors: Record<string, string> }
        ).colors;
        for (const key of keys) {
          expect(preset.swatch[key as keyof typeof preset.swatch]).toMatch(HEX);
          expect(colors[key]).toBe(
            preset.swatch[key as keyof typeof preset.swatch],
          );
        }
        for (const value of Object.values(colors)) expect(value).toMatch(HEX);
      });

      it('declares plain font family names consistent with its tokens', () => {
        const ff = (
          preset.theme_customizations as {
            typography: { fontFamily: { heading: string; body: string } };
          }
        ).typography.fontFamily;
        expect(ff).toEqual(preset.fonts);
        // Plain Google family names — the storefront quotes them itself.
        expect(preset.fonts.heading).not.toContain(',');
        expect(preset.fonts.body).not.toContain(',');
      });

      it('chrome flags are consistent with its header / footer sections', () => {
        const all = sections(preset);
        const has = (key: string) => all.some((s) => s.section_key === key);
        const headerBar = all.find((s) => s.section_key === 'header-bar');
        const copyright = all.find((s) => s.section_key === 'copyright-bar');

        expect(preset.chrome).toEqual({
          announcement_bar: has('announcement-bar'),
          sticky_header:
            !!headerBar && headerBar.settings.sticky_mode !== 'none',
          mega_menu: has('mega-menu'),
          mobile_bottom_nav: has('mobile-bottom-nav'),
          footer_columns: has('footer-columns'),
          social_icons: has('social-icons'),
          payment_icons:
            !!copyright && copyright.settings.show_payment_icons === true,
        });
      });

      it('always ships a header-bar, footer-columns and copyright-bar', () => {
        expect(preset.header.some((s) => s.section_key === 'header-bar')).toBe(
          true,
        );
        expect(
          preset.footer.some((s) => s.section_key === 'footer-columns'),
        ).toBe(true);
        expect(
          preset.footer.some((s) => s.section_key === 'copyright-bar'),
        ).toBe(true);
      });

      it('uses each chrome key at most once per page, on the right page', () => {
        for (const [list, allowed] of [
          [preset.header, HEADER_KEYS],
          [preset.footer, FOOTER_KEYS],
        ] as const) {
          const keys = list.map((s) => s.section_key);
          expect(new Set(keys).size).toBe(keys.length);
          for (const key of keys) expect(allowed.has(key)).toBe(true);
        }
      });

      it('only uses settings keys the storefront section definitions accept', () => {
        for (const s of sections(preset)) {
          const allowed = CHROME_SECTION_KEYS[s.section_key];
          expect(allowed).toBeDefined();
          for (const key of Object.keys(s.settings)) {
            expect(allowed.has(key)).toBe(true);
            expect(CONTENT_LIKE_KEYS.has(key)).toBe(false);
          }
        }
      });

      it('settings hold only scalars (no texts, images, urls or arrays)', () => {
        for (const s of sections(preset)) {
          for (const value of Object.values(s.settings)) {
            expect(['boolean', 'number', 'string']).toContain(typeof value);
            if (typeof value === 'string') {
              expect(value).not.toMatch(
                /^https?:|^\/|\.(png|jpe?g|svg|webp)$/i,
              );
            }
          }
        }
      });

      it('marks the sections whose generated content may be empty as hidden_when_empty', () => {
        for (const s of sections(preset)) {
          if (
            s.section_key === 'announcement-bar' ||
            s.section_key === 'social-icons'
          ) {
            expect(s.hidden_when_empty).toBe(true);
          }
        }
      });
    },
  );

  it('covers all three base themes and varied chrome layouts', () => {
    const bases = new Set(THEME_PRESETS.map((p) => p.base_theme_key));
    expect(bases).toEqual(new Set(['minimal', 'bold', 'classic']));
    const signatures = new Set(
      THEME_PRESETS.map((p) => JSON.stringify(p.chrome)),
    );
    expect(signatures.size).toBeGreaterThanOrEqual(4);
  });
});
