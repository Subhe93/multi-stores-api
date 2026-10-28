/**
 * Server-side copy of the dashboard's `occasion-page` section preset
 * (multi-stores-dashboard/src/lib/section-presets.ts, M6.5). The dashboard
 * inserts the preset with placeholder text; the conversion fills it with the
 * collection's own content. Keys mirror the theme registry: translatable
 * keys go into the section translation `content`, the rest into `settings`.
 * `occasion-preset.spec.ts` pins the keys so both copies stay aligned.
 */

export interface OccasionPageSource {
  /** Collection name — the hero heading and the page title. */
  name: string;
  /** Optional hero sub-heading (the collection's short description as text). */
  subheading: string | null;
  /** Hero image, when the collection has a thumbnail. */
  hero_image: string | null;
  /** The INTERNAL label whose products the page lists. */
  label_id: string;
  /** Sanitised HTML for the SEO block (long description, else description). */
  html: string;
  /** Heading of the products block, in the store locale. */
  products_heading: string;
  /** "View all" label of the products block, in the store locale. */
  products_link_label: string;
  /** Heading of the SEO block, in the store locale. */
  text_heading: string;
}

export interface OccasionSectionBody {
  section_key: string;
  settings: Record<string, unknown>;
  content: Record<string, unknown>;
}

/** Section keys of the preset, in order (the dashboard preset has the same). */
export const OCCASION_PRESET_KEYS = [
  'hero-banner',
  'collection-products',
  'rich-text',
] as const;

export const HERO_HEADING_MAX = 120;
export const HERO_SUBHEADING_MAX = 280;

/** Store-locale text of the preset (the dashboard preset carries en/ar/sv). */
export const OCCASION_PRESET_TEXT: Record<
  string,
  {
    products_heading: string;
    products_link_label: string;
    text_heading: string;
  }
> = {
  en: {
    products_heading: 'Our picks',
    products_link_label: 'View all',
    text_heading: 'About these gifts',
  },
  ar: {
    products_heading: 'مختاراتنا',
    products_link_label: 'عرض الكل',
    text_heading: 'عن هذه الهدايا',
  },
  sv: {
    products_heading: 'Våra favoriter',
    products_link_label: 'Visa alla',
    text_heading: 'Om dessa presenter',
  },
  tr: {
    products_heading: 'Seçtiklerimiz',
    products_link_label: 'Tümünü gör',
    text_heading: 'Bu hediyeler hakkında',
  },
  de: {
    products_heading: 'Unsere Auswahl',
    products_link_label: 'Alle ansehen',
    text_heading: 'Über diese Geschenke',
  },
  fr: {
    products_heading: 'Notre sélection',
    products_link_label: 'Voir tout',
    text_heading: 'À propos de ces cadeaux',
  },
};

export function occasionPresetText(locale: string) {
  return OCCASION_PRESET_TEXT[locale] ?? OCCASION_PRESET_TEXT.en;
}

function clip(value: string, max: number): string {
  const v = value.trim();
  return v.length <= max ? v : `${v.slice(0, max - 1).trimEnd()}…`;
}

/** The three section bodies of an occasion page, in preset order. */
export function occasionPageSections(
  src: OccasionPageSource,
): OccasionSectionBody[] {
  const hero: OccasionSectionBody = {
    section_key: 'hero-banner',
    settings: {
      layout: 'centered',
      height: 'md',
      overlay_opacity: 0.35,
      alignment: 'center',
      ...(src.hero_image ? { image: src.hero_image } : {}),
    },
    content: {
      heading: clip(src.name, HERO_HEADING_MAX),
      ...(src.subheading
        ? { subheading: clip(src.subheading, HERO_SUBHEADING_MAX) }
        : {}),
    },
  };
  const products: OccasionSectionBody = {
    section_key: 'collection-products',
    settings: {
      category: src.label_id,
      aspect: 'square',
      limit: 12,
      columns: 4,
      columns_tablet: 3,
      columns_mobile: 2,
    },
    content: {
      heading: src.products_heading,
      link_label: src.products_link_label,
    },
  };
  const text: OccasionSectionBody = {
    section_key: 'rich-text',
    settings: {
      width: 'normal',
      alignment: 'left',
      padding: 'medium',
      surface: false,
    },
    content: { heading: src.text_heading, html: src.html },
  };
  // A collection without any description gets no empty SEO block.
  return src.html.trim() ? [hero, products, text] : [hero, products];
}
