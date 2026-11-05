import { SUPPORTED_LOCALES } from '../markets/market.types';

// Which storefront content a normalised redirect source would shadow. The
// web proxy matches store redirects BEFORE routing, so a redirect from a path
// that still serves a published product, collection or page hides it. A
// merchant redirect from such a path is refused (REDIRECT_SHADOWS_LIVE); once
// the content is deleted, unpublished or renamed the same redirect is fine.
// Same URL shapes for every store type (see common/slug/slug-moves.ts):
// - product:    `/products/<slug>` (own products; custom products on
//               non-INDEPENDENT stores), any translation slug;
// - collection: `/collections/<root>/<child>/<self>`;
// - root page:  `/<slug>` (legacy static page or builder STATIC/LANDING).
// Each may carry a `/<locale>/` prefix.

export type LiveContentKind = 'product' | 'collection' | 'page';

export type LivePathCandidate =
  | { kind: 'product'; slug: string }
  | { kind: 'collection'; segments: string[] }
  | { kind: 'page'; slug: string };

const LOCALE_PREFIXES = new Set<string>(SUPPORTED_LOCALES);

/**
 * The content a normalised `from_path` could address, or null when no
 * product, collection or page lives at that shape (home `/`, shortlinks,
 * `/legal/…`, deeper paths). Pure; the service checks the candidate exists.
 */
export function livePathCandidate(
  normalized: string,
): LivePathCandidate | null {
  if (!normalized.startsWith('/') || normalized.startsWith('/?')) return null;
  let segs = normalized.slice(1).split('/');
  if (segs.some((s) => s === '')) return null;
  if (segs.length > 1 && LOCALE_PREFIXES.has(segs[0])) segs = segs.slice(1);
  if (segs[0] === 'products') {
    return segs.length === 2 ? { kind: 'product', slug: segs[1] } : null;
  }
  if (segs[0] === 'collections') {
    return segs.length >= 2
      ? { kind: 'collection', segments: segs.slice(1) }
      : null;
  }
  return segs.length === 1 ? { kind: 'page', slug: segs[0] } : null;
}

/** Comparison form of a stored slug (paths are decoded, NFC, lower case). */
export function slugKey(slug: string): string {
  return slug.normalize('NFC').toLowerCase();
}

/** Lookup forms of a path slug: NFC and NFD (legacy un-normalised rows). */
export function slugForms(slugs: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const s of slugs) {
    out.add(s);
    out.add(s.normalize('NFD'));
  }
  return [...out];
}

export interface CollectionNode {
  id: string;
  slug: string;
  parent_id: string | null;
  is_active: boolean;
  visibility: string;
}

/**
 * True when `segments` walks a served collection chain from a root: every
 * node active and not INTERNAL (the storefront's resolveCollectionChain).
 */
export function collectionChainIsLive(
  rows: readonly CollectionNode[],
  segments: readonly string[],
): boolean {
  let parent: string | null = null;
  for (const seg of segments) {
    const node = rows.find(
      (r) =>
        r.parent_id === parent &&
        r.is_active &&
        r.visibility !== 'INTERNAL' &&
        slugKey(r.slug) === seg,
    );
    if (!node) return false;
    parent = node.id;
  }
  return segments.length > 0;
}
