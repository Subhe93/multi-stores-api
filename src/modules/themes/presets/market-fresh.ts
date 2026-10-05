import type { ChromeSectionPreset, ThemePreset } from './types';
import { deriveChromeFlags, pickSwatch, type PresetColors } from './shared';

// ── Market Fresh ───────────────────────────────────────────────
// Friendly teal brand with a warm amber accent on a clean white canvas.
// Full-featured chrome: rotating announcement strip, always-sticky header
// with the cart drawer, link columns, social row and payment badges.

const colors: PresetColors = {
  primary: '#0f766e',
  secondary: '#115e59',
  accent: '#f59e0b',
  background: '#ffffff',
  surface: '#f0fdfa',
  text: '#0f172a',
  muted: '#5f6b7a',
  border: '#d9e7e4',
  primaryContrast: '#ffffff',
};

const fonts = { heading: 'Poppins', body: 'Inter' };

const header: ChromeSectionPreset[] = [
  {
    section_key: 'announcement-bar',
    settings: { layout: 'rotating', rotate_ms: 5000, dismissible: false },
    hidden_when_empty: true,
  },
  {
    section_key: 'header-bar',
    settings: {
      show_logo: true,
      show_store_name: true,
      logo_size: 36,
      show_search: true,
      show_cart: true,
      cart_action: 'popup',
      show_account: true,
      show_locale: true,
      sticky_mode: 'always',
    },
  },
];

const footer: ChromeSectionPreset[] = [
  { section_key: 'footer-columns', settings: {} },
  {
    section_key: 'social-icons',
    settings: {
      layout: 'horizontal',
      alignment: 'center',
      gap_px: 12,
      icon_style: 'solid',
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
    settings: { alignment: 'between', show_payment_icons: true },
  },
];

export const marketFreshPreset: ThemePreset = {
  id: 'market-fresh',
  name: { en: 'Market Fresh', ar: 'سوق طازج' },
  description: {
    en: 'Friendly teal and amber on white. Rotating announcement bar, sticky header with cart drawer, link columns, social icons and payment badges.',
    ar: 'أزرق مخضرّ ودود مع كهرماني على أبيض. شريط إعلان دوّار، هيدر مثبّت مع سلة منبثقة، أعمدة روابط، أيقونات تواصل وشارات دفع.',
  },
  tags: ['fresh', 'friendly', 'grocery', 'general', 'light'],
  base_theme_key: 'minimal',
  swatch: pickSwatch(colors),
  fonts,
  chrome: deriveChromeFlags(header, footer),
  theme_customizations: {
    colors,
    typography: {
      fontFamily: fonts,
      fontWeight: { heading: 700, body: 400, bold: 700 },
    },
    spacing: {
      radius: { sm: '10px', md: '16px', lg: '24px', full: '9999px' },
      containerMaxWidth: '1240px',
    },
  },
  header,
  footer,
};
