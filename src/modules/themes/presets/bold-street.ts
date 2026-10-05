import type { ChromeSectionPreset, ThemePreset } from './types';
import { deriveChromeFlags, pickSwatch, type PresetColors } from './shared';

// ── Bold Street ────────────────────────────────────────────────
// Orange on black streetwear energy: black header and footer strips with
// orange accents on a light page body, Archivo Black headlines, scrolling
// marquee announcement and a mobile bottom nav.

const colors: PresetColors = {
  primary: '#f97316',
  secondary: '#0a0a0a',
  accent: '#facc15',
  background: '#ffffff',
  surface: '#f5f5f4',
  text: '#0a0a0a',
  muted: '#57534e',
  border: '#e7e5e4',
  primaryContrast: '#0a0a0a',
};

const fonts = { heading: 'Archivo Black', body: 'Barlow' };

const header: ChromeSectionPreset[] = [
  {
    section_key: 'announcement-bar',
    settings: {
      layout: 'marquee',
      marquee_speed_s: 20,
      dismissible: false,
      bg_color: '#f97316',
      text_color: '#0a0a0a',
      link_color: '#0a0a0a',
    },
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
      show_account: false,
      show_locale: true,
      sticky_mode: 'always',
      bg_color: '#0a0a0a',
      text_color: '#ffffff',
      border_color: '#0a0a0a',
      accent_color: '#f97316',
    },
  },
  {
    section_key: 'mobile-bottom-nav',
    settings: {
      show_labels: true,
      bg_color: '#0a0a0a',
      text_color: '#a8a29e',
      active_color: '#f97316',
      border_color: '#262626',
    },
  },
];

const footer: ChromeSectionPreset[] = [
  {
    section_key: 'footer-columns',
    settings: {
      bg_color: '#0a0a0a',
      text_color: '#ffffff',
      heading_color: '#f97316',
      link_color: '#a8a29e',
    },
  },
  {
    section_key: 'social-icons',
    settings: {
      layout: 'horizontal',
      alignment: 'start',
      gap_px: 10,
      icon_style: 'solid',
      icon_shape: 'square',
      size: 'md',
      color_mode: 'custom',
      custom_color: '#0a0a0a',
      custom_bg_color: '#f97316',
      label_mode: 'never',
      hover_effect: 'lift',
    },
    hidden_when_empty: true,
  },
  {
    section_key: 'copyright-bar',
    settings: {
      alignment: 'between',
      show_payment_icons: true,
      bg_color: '#0a0a0a',
      text_color: '#a8a29e',
      border_color: '#262626',
    },
  },
];

export const boldStreetPreset: ThemePreset = {
  id: 'bold-street',
  name: { en: 'Bold Street', ar: 'شارع جريء' },
  description: {
    en: 'Orange on black streetwear energy. Marquee announcement, black sticky header, mobile bottom nav, dark footer with square social chips and payment badges.',
    ar: 'طاقة ستريت وير برتقالية على أسود. إعلان متحرّك، هيدر أسود مثبّت، شريط جوال سفلي، فوتر داكن مع أيقونات تواصل مربعة وشارات دفع.',
  },
  tags: ['bold', 'streetwear', 'youth', 'sneakers', 'high-contrast'],
  base_theme_key: 'bold',
  swatch: pickSwatch(colors),
  fonts,
  chrome: deriveChromeFlags(header, footer),
  theme_customizations: {
    colors,
    typography: {
      fontFamily: fonts,
      scale: { h1: 4, h2: 2.9, h3: 2.1 },
      lineHeight: { heading: 1.0, body: 1.6 },
      // Archivo Black ships a single 400 weight — a heavier value would only
      // trigger faux-bold in the browser.
      fontWeight: { heading: 400, body: 400, bold: 700 },
    },
    spacing: {
      radius: { sm: '0px', md: '2px', lg: '4px', full: '9999px' },
      containerMaxWidth: '1280px',
    },
  },
  header,
  footer,
};
