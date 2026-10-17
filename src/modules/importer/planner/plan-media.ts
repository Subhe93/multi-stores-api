import {
  mediaRefOf,
  presetHelpRefs,
  productMediaRefs,
  type MappedImage,
} from '../mapping/map-product';
import type { MediaTarget } from '../media/media-importer';
import type { PlanContext } from './plan-context';
import type {
  PlannedCategory,
  PlannedMedia,
  PlannedProduct,
  PlannedTemplate,
} from './plan-types';

export interface MediaPlan {
  media: PlannedMedia[];
  /** Every source URL the written entities reference (fix 2), scope or not. */
  mediaUrls: string[];
}

/** Media (D8, D9): one need per (target, source URL) of the entities that will be written. */
export function planMedia(
  ctx: PlanContext,
  categories: PlannedCategory[],
  products: PlannedProduct[],
  templates: PlannedTemplate[],
): MediaPlan {
  const { scopes, snapshot, push } = ctx;
  const media: PlannedMedia[] = [];
  if (scopes.media) {
    const seen = new Map<string, PlannedMedia>();
    const need = (img: MappedImage, target: MediaTarget) => {
      if (!img.source_url) return;
      const key = `${target}|${img.source_url}`;
      if (seen.has(key)) return;
      const have = snapshot.media.get(img.source_url);
      const ok = target === 'public' ? have?.public : have?.private;
      const pm: PlannedMedia = {
        source_url: img.source_url,
        candidates: img.candidates,
        target,
        action: ok ? 'UNCHANGED' : 'CREATE',
      };
      seen.set(key, pm);
      media.push(pm);
    };
    if (scopes.categories)
      for (const c of categories)
        if (
          (c.action === 'CREATE' || c.action === 'UPDATE') &&
          c.mapped.thumbnail
        )
          need(mediaRefOf(c.mapped.thumbnail), 'public');
    if (scopes.products)
      for (const p of products) {
        if (p.action === 'CREATE' || p.action === 'UPDATE')
          productMediaRefs(p.mapped).forEach((i) => need(i, 'public'));
        for (const pr of p.presets)
          if (pr.action === 'CREATE' || pr.action === 'UPDATE')
            presetHelpRefs(p.mapped, pr.descriptor.source_ref).forEach((i) =>
              need(i, 'public'),
            );
      }
    for (const t of templates) {
      if (t.action === 'UNCHANGED') continue;
      if (t.template.thumbnail && !t.template.thumbnail.missing)
        need(mediaRefOf(t.template.thumbnail), 'private');
      for (const a of t.template.assets)
        if (!a.missing && a.url) need(mediaRefOf(a), 'private');
    }
    for (const m of media)
      push({
        entity_type: 'MEDIA',
        external_ref: `${m.target}:${m.source_url}`.slice(0, 255),
        action: m.action,
        target_id: null,
      });
  }

  const mediaUrls = new Set<string>(media.map((m) => m.source_url));
  if (scopes.categories)
    for (const c of categories)
      if (
        (c.action === 'CREATE' || c.action === 'UPDATE') &&
        c.mapped.thumbnail
      )
        mediaUrls.add(c.mapped.thumbnail.url);
  if (scopes.products)
    for (const p of products) {
      if (p.action === 'CREATE' || p.action === 'UPDATE')
        for (const i of productMediaRefs(p.mapped)) mediaUrls.add(i.source_url);
      for (const pr of p.presets)
        for (const i of presetHelpRefs(p.mapped, pr.descriptor.source_ref))
          mediaUrls.add(i.source_url);
    }
  for (const t of templates)
    for (const r of [
      ...(t.template.thumbnail ? [t.template.thumbnail] : []),
      ...t.template.assets,
    ])
      if (r.url) mediaUrls.add(r.url);

  return { media, mediaUrls: [...mediaUrls] };
}
