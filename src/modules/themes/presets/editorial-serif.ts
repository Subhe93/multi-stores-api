import type { ChromeSectionPreset, ThemePreset } from './types';
import { deriveChromeFlags, pickSwatch, type PresetColors } from './shared';

// ── Editorial Serif ────────────────────────────────────────────
// Black on white, Playfair Display headlines over Lora body, sharp corners.
// Quiet chrome: no announcement strip, header sticky on desktop only, link
// columns and a centred copyright line — no social row, no payment badges.

const colors: PresetColors = {
  primary: '#111111',
  secondary: '#3f3f46',
  accent: '#525252',
  background: '#ffffff',
  surface: '#fafafa',
  text: '#111111',
  muted: '#737373',
  border: '#e5e5e5',
  primaryContrast: '#ffffff',
};

const fonts = { heading: 'Playfair Display', body: 'Lora' };

// Playfair Display and Lora have no Arabic glyphs. Noto Naskh Arabic is the
// naskh counterpart of a Latin serif; the storefront places it after the
// Latin family, so it only draws Arabic-script text. One family for both
// slots = one font file. Must be a name from the storefront's curated list
// (multi-stores-web/src/lib/arabicFonts.ts). Written when the look is
// applied: stores that applied it earlier keep their stored tokens.
const fontsArabic = { heading: 'Noto Naskh Arabic', body: 'Noto Naskh Arabic' };

const header: ChromeSectionPreset[] = [
  {
    section_key: 'header-bar',
    settings: {
      show_logo: true,
      show_store_name: true,
      logo_size: 40,
      // A wide wordmark keeps its proportions under this height (storefront
      // header setting; the look's own logo size arrives with it).
      logo_fit: 'height',
      show_search: true,
      show_cart: true,
      cart_action: 'page',
      show_account: false,
      show_locale: true,
      sticky_mode: 'desktop',
    },
  },
];

const footer: ChromeSectionPreset[] = [
  { section_key: 'footer-columns', settings: {} },
  {
    section_key: 'copyright-bar',
    settings: { alignment: 'center', show_payment_icons: false },
  },
];

export const editorialSerifPreset: ThemePreset = {
  id: 'editorial-serif',
  name: { en: 'Editorial Serif', ar: 'تحريري سيريف' },
  description: {
    en: 'Black on white with Playfair Display headlines and sharp corners. Minimal chrome: desktop-sticky header, link columns and a centred copyright line.',
    ar: 'أسود على أبيض مع عناوين Playfair Display وزوايا حادة. واجهة هادئة: هيدر مثبّت على سطح المكتب، أعمدة روابط وسطر حقوق في الوسط.',
  },
  tags: ['editorial', 'serif', 'monochrome', 'fashion', 'luxury'],
  base_theme_key: 'minimal',
  swatch: pickSwatch(colors),
  fonts,
  chrome: deriveChromeFlags(header, footer),
  theme_customizations: {
    colors,
    typography: {
      fontFamily: fonts,
      fontFamilyArabic: fontsArabic,
      scale: { h1: 3.75, h2: 2.75, h3: 2 },
      lineHeight: { heading: 1.08, body: 1.7 },
      fontWeight: { heading: 600, body: 400, bold: 700 },
    },
    spacing: {
      radius: { sm: '2px', md: '4px', lg: '8px', full: '9999px' },
      containerMaxWidth: '1120px',
    },
  },
  header,
  footer,
};
