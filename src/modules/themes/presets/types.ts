// ── Look-only theme preset catalog types ──────────────────────────
// A ThemePreset changes ONLY the store's look: design tokens
// (theme_customizations) plus the layout settings of the HEADER / FOOTER
// chrome sections. It never carries texts, nav links, images, categories or
// URLs — those stay the creator's. Applied by ThemesService.apply.

export type LocalizedString = Record<string, string>;

export type BaseThemeKey = 'minimal' | 'bold' | 'classic';

export interface ThemeSwatch {
  primary: string;
  secondary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
}

export interface ThemeFonts {
  heading: string;
  body: string;
}

// Which chrome features the preset turns on. Derived from the header /
// footer section lists (see deriveChromeFlags) so the gallery can show
// feature badges without parsing sections.
export interface ThemeChromeFlags {
  announcement_bar: boolean;
  sticky_header: boolean;
  mega_menu: boolean;
  mobile_bottom_nav: boolean;
  footer_columns: boolean;
  social_icons: boolean;
  payment_icons: boolean;
}

// Lightweight shape returned by the list / detail endpoints.
export interface ThemePresetSummary {
  id: string;
  name: LocalizedString; // at least en + ar
  description: LocalizedString; // at least en + ar
  tags: string[];
  base_theme_key: BaseThemeKey;
  swatch: ThemeSwatch;
  fonts: ThemeFonts;
  chrome: ThemeChromeFlags;
}

export interface ChromeSectionPreset {
  // Theme registry key, e.g. 'header-bar', 'footer-columns'.
  section_key: string;
  // Layout / style knobs only (booleans, selects, numbers, colours). Keys
  // must exist in the storefront section definition's schema.
  settings: Record<string, unknown>;
  // When the section is created and its generated default content is empty
  // (e.g. no social links configured, no announcement messages), create it
  // hidden so the storefront never renders an empty strip.
  hidden_when_empty?: boolean;
}

export interface ThemePreset extends ThemePresetSummary {
  // Shape per multi-stores-web/src/themes/types.ts ThemeCustomizations
  // (colors / typography.fontFamily / spacing.radius ...). Font families are
  // plain Google Fonts family names — the storefront quotes them itself.
  theme_customizations: Record<string, unknown>;
  // Ordered chrome sections for the HEADER page.
  header: ChromeSectionPreset[];
  // Ordered chrome sections for the FOOTER page.
  footer: ChromeSectionPreset[];
}
