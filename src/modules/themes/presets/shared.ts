import type {
  ChromeSectionPreset,
  ThemeChromeFlags,
  ThemePreset,
  ThemePresetSummary,
  ThemeSwatch,
} from './types';

// Full colour token set a preset authors once; the swatch is picked from it.
export interface PresetColors extends ThemeSwatch {
  muted: string;
  border: string;
  primaryContrast: string;
}

/** The six gallery swatch colours, picked from the full colour tokens. */
export function pickSwatch(colors: PresetColors): ThemeSwatch {
  return {
    primary: colors.primary,
    secondary: colors.secondary,
    accent: colors.accent,
    background: colors.background,
    surface: colors.surface,
    text: colors.text,
  };
}

/**
 * Derive the chrome feature flags from the preset's section lists so the
 * badges shown in the gallery can never drift from what apply() creates.
 */
export function deriveChromeFlags(
  header: ChromeSectionPreset[],
  footer: ChromeSectionPreset[],
): ThemeChromeFlags {
  const all = [...header, ...footer];
  const has = (key: string) => all.some((s) => s.section_key === key);
  const headerBar = all.find((s) => s.section_key === 'header-bar');
  const copyright = all.find((s) => s.section_key === 'copyright-bar');
  return {
    announcement_bar: has('announcement-bar'),
    sticky_header: !!headerBar && headerBar.settings.sticky_mode !== 'none',
    mega_menu: has('mega-menu'),
    mobile_bottom_nav: has('mobile-bottom-nav'),
    footer_columns: has('footer-columns'),
    social_icons: has('social-icons'),
    payment_icons:
      !!copyright && copyright.settings.show_payment_icons === true,
  };
}

/** Strip the heavy fields so list / detail endpoints stay lightweight. */
export function toSummary(preset: ThemePreset): ThemePresetSummary {
  return {
    id: preset.id,
    name: preset.name,
    description: preset.description,
    tags: preset.tags,
    base_theme_key: preset.base_theme_key,
    swatch: preset.swatch,
    fonts: preset.fonts,
    chrome: preset.chrome,
  };
}
