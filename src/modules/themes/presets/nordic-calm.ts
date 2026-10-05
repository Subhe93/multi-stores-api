import type { ChromeSectionPreset, ThemePreset } from './types';
import { deriveChromeFlags, pickSwatch, type PresetColors } from './shared';

// ── Nordic Calm ────────────────────────────────────────────────
// Cool slate greys with a blue accent, Inter everywhere, compact type
// scale and container. Lean chrome: a compact always-sticky header, link
// columns and payment badges — no announcement strip, no social row.

const colors: PresetColors = {
  primary: '#334155',
  secondary: '#475569',
  accent: '#3b82f6',
  background: '#ffffff',
  surface: '#f8fafc',
  text: '#0f172a',
  muted: '#64748b',
  border: '#e2e8f0',
  primaryContrast: '#ffffff',
};

const fonts = { heading: 'Inter', body: 'Inter' };

const header: ChromeSectionPreset[] = [
  {
    section_key: 'header-bar',
    settings: {
      show_logo: true,
      show_store_name: true,
      logo_size: 28,
      show_search: true,
      show_cart: true,
      cart_action: 'popup',
      show_account: false,
      show_locale: true,
      sticky_mode: 'always',
    },
  },
];

const footer: ChromeSectionPreset[] = [
  { section_key: 'footer-columns', settings: {} },
  {
    section_key: 'copyright-bar',
    settings: { alignment: 'between', show_payment_icons: true },
  },
];

export const nordicCalmPreset: ThemePreset = {
  id: 'nordic-calm',
  name: { en: 'Nordic Calm', ar: 'هدوء شمالي' },
  description: {
    en: 'Cool slate greys with a blue accent and Inter throughout. Compact scale, lean sticky header, link columns and payment badges.',
    ar: 'رمادي بارد مع لمسة زرقاء وخط Inter في كل مكان. مقياس مضغوط، هيدر مثبّت بسيط، أعمدة روابط وشارات دفع.',
  },
  tags: ['nordic', 'minimal', 'calm', 'tech', 'compact'],
  base_theme_key: 'minimal',
  swatch: pickSwatch(colors),
  fonts,
  chrome: deriveChromeFlags(header, footer),
  theme_customizations: {
    colors,
    typography: {
      fontFamily: fonts,
      scale: { h1: 2.75, h2: 2.1, h3: 1.6, h4: 1.3, h5: 1.1, h6: 1 },
      lineHeight: { heading: 1.15, body: 1.6 },
      fontWeight: { heading: 600, body: 400, bold: 600 },
    },
    spacing: {
      radius: { sm: '6px', md: '10px', lg: '14px', full: '9999px' },
      containerMaxWidth: '1120px',
    },
  },
  header,
  footer,
};
