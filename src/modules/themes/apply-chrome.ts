// Pure, Prisma-free helpers behind ThemesService.apply: planning how a
// preset's chrome sections map onto a page's existing sections, and
// generating neutral default content for sections the preset creates.

import type { ChromeSectionPreset } from './presets/types';

// ── Section planning ───────────────────────────────────────────

export interface ExistingChromeSection {
  id: string;
  section_key: string;
  settings: Record<string, unknown>;
  sort_order: number;
  is_hidden: boolean;
}

export interface ChromeSectionUpdate {
  id: string;
  settings: Record<string, unknown>;
  sort_order: number;
  // Only set when the hidden flag must change (a section this feature hid
  // when a previous preset dropped it comes back when a preset uses it).
  is_hidden?: boolean;
}

export interface ChromeSectionCreate {
  section_key: string;
  settings: Record<string, unknown>;
  sort_order: number;
  hidden: boolean;
}

export interface ChromePlan {
  // Existing sections matched by key: settings merged (preset wins) and
  // moved to the preset's position. Content is never part of the plan.
  updates: ChromeSectionUpdate[];
  // Preset sections the page lacks.
  creates: ChromeSectionCreate[];
  // Sections the preset does not mention: untouched except for sort_order,
  // re-packed after the preset ones in their previous relative order. A
  // section created by an earlier preset (THEME_MANAGED_KEY) is hidden, so
  // switching presets never leaves a stale mega menu or bottom nav behind.
  untouchedSortOrders: {
    id: string;
    sort_order: number;
    is_hidden?: boolean;
  }[];
}

// Marker written into the settings of sections this feature creates, so a
// later preset may hide them again. Creator-authored sections never carry it.
export const THEME_MANAGED_KEY = '_theme_managed';

// Section-level colour overrides are part of the look. When a preset does not
// set one, the value left by a previous preset must not survive the switch.
export function isLookKey(key: string): boolean {
  return key.endsWith('_color');
}

function withoutLookKeys(
  settings: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(settings).filter(([key]) => !isLookKey(key)),
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Plan the changes a preset makes to one chrome page.
 *
 * - For each preset section (in order) the FIRST existing section with the
 *   same key is updated: `{ ...existing.settings, ...preset.settings }` and
 *   `sort_order = preset index`. Existing extra keys (logo override, images,
 *   menu_key ...) survive; preset keys win.
 * - Keys the page lacks are created with the preset settings. `hidden` is
 *   true only when the preset marks `hidden_when_empty` AND the key is in
 *   `emptyKeys` (the caller's generated content was empty).
 * - Everything else — including a SECOND section of a key the preset
 *   mentions once — is kept as is and re-sorted after the preset sections,
 *   preserving its relative order. Nothing is ever deleted.
 */
export function planChromeSections(
  existing: ExistingChromeSection[],
  preset: ChromeSectionPreset[],
  emptyKeys: ReadonlySet<string> = new Set(),
): ChromePlan {
  const updates: ChromeSectionUpdate[] = [];
  const creates: ChromeSectionCreate[] = [];
  const claimed = new Set<string>();

  // Match in the page's own order so "first" is deterministic.
  const ordered = [...existing].sort((a, b) =>
    a.sort_order !== b.sort_order
      ? a.sort_order - b.sort_order
      : existing.indexOf(a) - existing.indexOf(b),
  );

  preset.forEach((section, index) => {
    const match = ordered.find(
      (s) => s.section_key === section.section_key && !claimed.has(s.id),
    );
    if (match) {
      claimed.add(match.id);
      const existingSettings = asRecord(match.settings);
      const update: ChromeSectionUpdate = {
        id: match.id,
        settings: { ...withoutLookKeys(existingSettings), ...section.settings },
        sort_order: index,
      };
      // A section an earlier preset created and a later one hid is wanted
      // again: show it, unless the preset itself keeps it hidden when empty.
      if (match.is_hidden && existingSettings[THEME_MANAGED_KEY] === true) {
        update.is_hidden =
          section.hidden_when_empty === true &&
          emptyKeys.has(section.section_key);
      }
      updates.push(update);
      return;
    }
    creates.push({
      section_key: section.section_key,
      settings: { ...section.settings, [THEME_MANAGED_KEY]: true },
      sort_order: index,
      hidden:
        section.hidden_when_empty === true &&
        emptyKeys.has(section.section_key),
    });
  });

  let next = preset.length;
  const untouchedSortOrders = ordered
    .filter((s) => !claimed.has(s.id))
    .map((s) => {
      const entry: { id: string; sort_order: number; is_hidden?: boolean } = {
        id: s.id,
        sort_order: next++,
      };
      if (asRecord(s.settings)[THEME_MANAGED_KEY] === true && !s.is_hidden) {
        entry.is_hidden = true;
      }
      return entry;
    });

  return { updates, creates, untouchedSortOrders };
}

// ── Default content generators ─────────────────────────────────

export type SocialsConfig = Partial<
  Record<'instagram' | 'facebook' | 'tiktok' | 'youtube' | 'twitter', unknown>
>;

export interface GeneratorContext {
  // Store.theme_config.socials — the only store fact we may read.
  socials?: SocialsConfig | null;
}

export interface GeneratedContent {
  content: Record<string, unknown>;
  // False when the section would render nothing useful (no messages, no
  // social links). Callers pair it with `hidden_when_empty`.
  meaningful: boolean;
}

type Labels = Record<string, string>;

// Labels for the generated navigation / footer links. English is the
// fallback for any locale not listed here.
const LABELS: Record<string, Labels> = {
  home: {
    en: 'Home',
    ar: 'الرئيسية',
    tr: 'Ana Sayfa',
    de: 'Startseite',
    fr: 'Accueil',
    sv: 'Startsida',
  },
  products: {
    en: 'Products',
    ar: 'المنتجات',
    tr: 'Ürünler',
    de: 'Produkte',
    fr: 'Produits',
    sv: 'Produkter',
  },
  collections: {
    en: 'Collections',
    ar: 'التصنيفات',
    tr: 'Koleksiyonlar',
    de: 'Kollektionen',
    fr: 'Collections',
    sv: 'Kollektioner',
  },
  all_products: {
    en: 'All products',
    ar: 'كل المنتجات',
    tr: 'Tüm ürünler',
    de: 'Alle Produkte',
    fr: 'Tous les produits',
    sv: 'Alla produkter',
  },
  shop: {
    en: 'Shop',
    ar: 'تسوّق',
    tr: 'Alışveriş',
    de: 'Einkaufen',
    fr: 'Acheter',
    sv: 'Handla',
  },
  help: {
    en: 'Help',
    ar: 'المساعدة',
    tr: 'Yardım',
    de: 'Hilfe',
    fr: 'Aide',
    sv: 'Hjälp',
  },
  shipping: {
    en: 'Shipping',
    ar: 'الشحن',
    tr: 'Kargo',
    de: 'Versand',
    fr: 'Livraison',
    sv: 'Frakt',
  },
  returns: {
    en: 'Returns',
    ar: 'الإرجاع',
    tr: 'İadeler',
    de: 'Rückgabe',
    fr: 'Retours',
    sv: 'Returer',
  },
  track_order: {
    en: 'Track my order',
    ar: 'تتبّع طلبي',
    tr: 'Siparişimi takip et',
    de: 'Bestellung verfolgen',
    fr: 'Suivre ma commande',
    sv: 'Spåra min order',
  },
  store: {
    en: 'Store',
    ar: 'المتجر',
    tr: 'Mağaza',
    de: 'Shop',
    fr: 'Boutique',
    sv: 'Butiken',
  },
  terms: {
    en: 'Terms',
    ar: 'الشروط',
    tr: 'Şartlar',
    de: 'AGB',
    fr: 'Conditions',
    sv: 'Villkor',
  },
  privacy: {
    en: 'Privacy',
    ar: 'الخصوصية',
    tr: 'Gizlilik',
    de: 'Datenschutz',
    fr: 'Confidentialité',
    sv: 'Integritet',
  },
  copyright: {
    en: '© {year} {store}. All rights reserved.',
    ar: '© {year} {store}. جميع الحقوق محفوظة.',
    tr: '© {year} {store}. Tüm hakları saklıdır.',
    de: '© {year} {store}. Alle Rechte vorbehalten.',
    fr: '© {year} {store}. Tous droits réservés.',
    sv: '© {year} {store}. Alla rättigheter förbehållna.',
  },
};

export function label(key: string, locale: string): string {
  const byLocale = LABELS[key] ?? {};
  return byLocale[locale] ?? byLocale.en ?? String(key);
}

// Social platforms the storefront `social-icons` section knows that can be
// pre-filled from Store.theme_config.socials.
const SOCIAL_PLATFORMS = [
  'instagram',
  'facebook',
  'tiktok',
  'youtube',
  'twitter',
] as const;

/** Non-empty social links from the store config, in a stable order. */
export function socialItems(
  socials: SocialsConfig | null | undefined,
): { platform: string; url: string }[] {
  if (!socials || typeof socials !== 'object') return [];
  const items: { platform: string; url: string }[] = [];
  for (const platform of SOCIAL_PLATFORMS) {
    const raw = socials[platform];
    if (typeof raw !== 'string') continue;
    const url = raw.trim();
    if (!url) continue;
    items.push({ platform, url });
  }
  return items;
}

/**
 * Default per-locale content for a chrome section the preset creates. Only
 * neutral navigation (Home / Products / Collections / legal pages) is
 * generated — never store facts such as shipping promises or prices.
 */
export function generateDefaultContent(
  sectionKey: string,
  locale: string,
  ctx: GeneratorContext = {},
): GeneratedContent {
  switch (sectionKey) {
    case 'header-bar':
      return {
        content: {
          items: [
            { label: label('home', locale), url: '/' },
            { label: label('products', locale), url: '/products' },
            { label: label('collections', locale), url: '/collections' },
          ],
        },
        meaningful: true,
      };

    case 'mega-menu':
      // Triggers without columns behave as plain links on every device.
      return {
        content: {
          triggers: [
            { label: label('home', locale), url: '/' },
            { label: label('products', locale), url: '/products' },
            { label: label('collections', locale), url: '/collections' },
          ],
        },
        meaningful: true,
      };

    case 'mobile-bottom-nav':
      // Item types carry their own icon + label in the storefront.
      return {
        content: {
          items: [
            { type: 'home' },
            { type: 'search' },
            { type: 'categories' },
            { type: 'cart' },
          ],
        },
        meaningful: true,
      };

    case 'announcement-bar':
      // Promotional messages are store facts — never invented here.
      return { content: { messages: [] }, meaningful: false };

    case 'footer-columns':
      return {
        content: {
          columns: [
            {
              heading: label('shop', locale),
              links: [
                { label: label('all_products', locale), url: '/products' },
                { label: label('collections', locale), url: '/collections' },
              ],
            },
            {
              heading: label('help', locale),
              links: [
                { label: label('shipping', locale), url: '/legal/shipping' },
                { label: label('returns', locale), url: '/legal/refund' },
                {
                  label: label('track_order', locale),
                  url: '/account/orders',
                },
              ],
            },
            {
              heading: label('store', locale),
              links: [
                { label: label('terms', locale), url: '/legal/terms' },
                { label: label('privacy', locale), url: '/legal/privacy' },
              ],
            },
          ],
        },
        meaningful: true,
      };

    case 'social-icons': {
      const items = socialItems(ctx.socials);
      return { content: { items }, meaningful: items.length > 0 };
    }

    case 'copyright-bar':
      // The preset's `show_payment_icons` decides whether badges render; the
      // labels are the creator's to fill in.
      return {
        content: { text: label('copyright', locale), payment_methods: [] },
        meaningful: true,
      };

    default:
      return { content: {}, meaningful: false };
  }
}

/**
 * Keys of the preset sections whose generated content is empty for this
 * store (locale-independent — emptiness only depends on store config).
 */
export function emptyContentKeys(
  preset: ChromeSectionPreset[],
  ctx: GeneratorContext = {},
): Set<string> {
  const empty = new Set<string>();
  for (const section of preset) {
    const { meaningful } = generateDefaultContent(
      section.section_key,
      'en',
      ctx,
    );
    if (!meaningful) empty.add(section.section_key);
  }
  return empty;
}
