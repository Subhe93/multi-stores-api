import type { PageType, StaticPageType } from '@prisma/client';

// ── Template Kit catalog types ──────────────────────────────────
// A Kit is a code-defined, JSON-serialisable description of a full store
// design: pages → sections (settings + per-locale content) + theme styling +
// bundled image assets + optional demo data. Kits are applied to a creator's
// store by TemplatesService.importKit.

export type LocalizedString = Record<string, string>;

export interface KitSection {
  // Theme registry key, e.g. 'hero-slider', 'product-page'.
  section_key: string;
  // Non-translatable, single-value-across-locales knobs (layout, colors,
  // image, category slug, …). May contain "@asset/<key>" placeholders.
  settings?: Record<string, unknown>;
  // Per-locale content keyed by locale: { en: {...}, ar: {...} }. On import,
  // each store locale is seeded with content[locale] ?? content[fallbackLocale].
  // May also contain "@asset/<key>" placeholders (e.g. inside slide/item arrays).
  content?: Record<string, Record<string, unknown>>;
}

export interface KitPageTranslation {
  locale: string;
  title?: string;
  meta_title?: string;
  meta_description?: string;
}

export interface KitPage {
  type: PageType;
  static_kind?: StaticPageType;
  slug?: string;
  translations?: KitPageTranslation[];
  sections: KitSection[];
}

export interface KitAsset {
  // Path relative to assets/templates/<kitId>/ — copied into the store's
  // uploads on import (Phase 2). `alt` seeds an alt text where relevant.
  file: string;
  alt?: string;
}

export interface KitDemoProduct {
  title: LocalizedString;
  description?: LocalizedString;
  base_price: number;
  compare_at_price?: number;
  images: string[]; // "@asset/<key>"
}

export interface KitDemoData {
  category: { slug: string; translations: { locale: string; name: string }[] };
  products: KitDemoProduct[];
}

export interface Kit {
  id: string;
  name: LocalizedString;
  description: LocalizedString;
  tags: string[];
  previewImage: string; // "@asset/<key>" — catalog thumbnail
  themeKey: string;
  themeCustomizations: Record<string, unknown>;
  // Locale to fall back to when a store locale has no authored content.
  fallbackLocale: string;
  pages: KitPage[];
  assets: Record<string, KitAsset>;
  demoData?: KitDemoData;
}

// Lightweight shape returned by the list endpoint (no heavy page data).
export interface KitSummary {
  id: string;
  name: LocalizedString;
  description: LocalizedString;
  tags: string[];
  previewImage: string;
}
