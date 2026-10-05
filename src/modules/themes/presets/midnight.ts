import type { ChromeSectionPreset, ThemePreset } from './types';
import { deriveChromeFlags, pickSwatch, type PresetColors } from './shared';

// ── Midnight ───────────────────────────────────────────────────
// Deep navy background with light text, violet primary and cyan accent.
// Space Grotesk headlines over DM Sans. Rotating announcement, sticky header
// with account link, icon-only mobile bottom nav, plain social icons.

const colors: PresetColors = {
  primary: '#a78bfa',
  secondary: '#c4b5fd',
  accent: '#22d3ee',
  background: '#0b1020',
  surface: '#141a2e',
  text: '#e6e9f2',
  muted: '#9aa3b8',
  border: '#273049',
  primaryContrast: '#0b1020',
};

const fonts = { heading: 'Space Grotesk', body: 'DM Sans' };

const header: ChromeSectionPreset[] = [
  {
    section_key: 'announcement-bar',
    settings: { layout: 'rotating', rotate_ms: 6000, dismissible: false },
    hidden_when_empty: true,
  },
  {
    section_key: 'header-bar',
    settings: {
      show_logo: true,
      show_store_name: true,
      logo_size: 32,
      show_search: true,
      show_cart: true,
      cart_action: 'popup',
      show_account: true,
      show_locale: true,
      sticky_mode: 'always',
    },
  },
  {
    section_key: 'mobile-bottom-nav',
    settings: { show_labels: false },
  },
];

const footer: ChromeSectionPreset[] = [
  { section_key: 'footer-columns', settings: {} },
  {
    section_key: 'social-icons',
    settings: {
      layout: 'horizontal',
      alignment: 'center',
      gap_px: 16,
      icon_style: 'plain',
      icon_shape: 'circle',
      size: 'sm',
      color_mode: 'theme-text',
      label_mode: 'never',
      hover_effect: 'scale',
    },
    hidden_when_empty: true,
  },
  {
    section_key: 'copyright-bar',
    settings: { alignment: 'between', show_payment_icons: false },
  },
];

export const midnightPreset: ThemePreset = {
  id: 'midnight',
  name: { en: 'Midnight', ar: 'منتصف الليل' },
  description: {
    en: 'Deep navy with light text, violet primary and cyan accent. Rotating announcement, sticky header, icon-only mobile bottom nav and plain social icons.',
    ar: 'كحلي عميق مع نص فاتح، بنفسجي أساسي ولمسة سماوية. إعلان دوّار، هيدر مثبّت، شريط جوال سفلي بالأيقونات فقط وأيقونات تواصل بسيطة.',
  },
  tags: ['dark', 'night', 'tech', 'gaming', 'modern'],
  base_theme_key: 'bold',
  swatch: pickSwatch(colors),
  fonts,
  chrome: deriveChromeFlags(header, footer),
  theme_customizations: {
    colors,
    typography: {
      fontFamily: fonts,
      lineHeight: { heading: 1.1, body: 1.65 },
      fontWeight: { heading: 700, body: 400, bold: 700 },
    },
    spacing: {
      radius: { sm: '8px', md: '12px', lg: '20px', full: '9999px' },
      shadow: {
        sm: '0 1px 2px rgb(0 0 0 / 0.4)',
        md: '0 6px 20px rgb(0 0 0 / 0.45)',
        lg: '0 20px 48px rgb(0 0 0 / 0.55)',
      },
      containerMaxWidth: '1200px',
    },
  },
  header,
  footer,
};
