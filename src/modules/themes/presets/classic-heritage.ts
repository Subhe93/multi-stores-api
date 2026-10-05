import type { ChromeSectionPreset, ThemePreset } from './types';
import { deriveChromeFlags, pickSwatch, type PresetColors } from './shared';

// ── Classic Heritage ───────────────────────────────────────────
// Warm browns and cream, Merriweather headlines over Lato. Traditional
// chrome: single announcement line, desktop-sticky header with account
// link, a centred mega menu bar, outlined social icons and a centred
// copyright line.

const colors: PresetColors = {
  primary: '#7c2d12',
  secondary: '#44403c',
  accent: '#b45309',
  background: '#fffbf5',
  surface: '#f5ebe0',
  text: '#292524',
  muted: '#78716c',
  border: '#e7dccd',
  primaryContrast: '#fffbf5',
};

const fonts = { heading: 'Merriweather', body: 'Lato' };

const header: ChromeSectionPreset[] = [
  {
    section_key: 'announcement-bar',
    settings: { layout: 'simple', dismissible: true },
    hidden_when_empty: true,
  },
  {
    section_key: 'header-bar',
    settings: {
      show_logo: true,
      show_store_name: true,
      logo_size: 44,
      show_search: true,
      show_cart: true,
      cart_action: 'page',
      show_account: true,
      show_locale: true,
      sticky_mode: 'desktop',
    },
  },
  {
    section_key: 'mega-menu',
    settings: { alignment: 'center' },
  },
];

const footer: ChromeSectionPreset[] = [
  { section_key: 'footer-columns', settings: {} },
  {
    section_key: 'social-icons',
    settings: {
      layout: 'horizontal',
      alignment: 'center',
      gap_px: 14,
      icon_style: 'outline',
      icon_shape: 'circle',
      size: 'sm',
      color_mode: 'theme-primary',
      label_mode: 'never',
      hover_effect: 'scale',
    },
    hidden_when_empty: true,
  },
  {
    section_key: 'copyright-bar',
    settings: { alignment: 'center', show_payment_icons: false },
  },
];

export const classicHeritagePreset: ThemePreset = {
  id: 'classic-heritage',
  name: { en: 'Classic Heritage', ar: 'تراث كلاسيكي' },
  description: {
    en: 'Warm browns and cream with Merriweather headlines. Dismissible announcement, desktop-sticky header, centred mega menu, outlined social icons and a centred copyright line.',
    ar: 'بنّي دافئ وكريمي مع عناوين Merriweather. إعلان قابل للإغلاق، هيدر مثبّت على سطح المكتب، قائمة موسّعة في الوسط، أيقونات تواصل بإطار وسطر حقوق في الوسط.',
  },
  tags: ['classic', 'heritage', 'artisan', 'warm', 'serif'],
  base_theme_key: 'classic',
  swatch: pickSwatch(colors),
  fonts,
  chrome: deriveChromeFlags(header, footer),
  theme_customizations: {
    colors,
    typography: {
      fontFamily: fonts,
      lineHeight: { heading: 1.15, body: 1.7 },
      fontWeight: { heading: 700, body: 400, bold: 700 },
    },
    spacing: {
      radius: { sm: '4px', md: '8px', lg: '12px', full: '9999px' },
      containerMaxWidth: '1160px',
    },
  },
  header,
  footer,
};
