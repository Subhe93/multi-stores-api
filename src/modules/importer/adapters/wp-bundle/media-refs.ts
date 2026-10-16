import type { NIssue, NMediaRef } from '../../model/normalized';
import type { WpTables } from './wp-tables';
import type { ExternalRefKind } from '../../model/external-ref';

/**
 * Builds `NMediaRef`s from attachment ids and raw URLs (M4.4 D8–D10):
 * - alias hosts are rewritten to the site host (Namez `3dnamez.se → namez.se`),
 *   and the site host is always addressed over https;
 * - candidates follow D9: `original_image` from the v1 metadata, then the
 *   path without `-scaled`, then the URL as given;
 * - an attachment id that the bundle does not contain becomes a `missing`
 *   ref (`W_MEDIA_MISSING_IN_BUNDLE`), so the report can show it.
 */
export class MediaRefResolver {
  private readonly missingReported = new Set<number>();

  constructor(
    private readonly tables: WpTables,
    private readonly siteHost: string,
    private readonly aliases: string[],
    private readonly uploadsBase: string,
    private readonly ref: (
      kind: ExternalRefKind,
      id: string | number,
    ) => string,
    private readonly issues: NIssue[],
  ) {}

  /** Rewrite alias hosts; returns '' for unusable input. */
  normalizeUrl(raw: string | null | undefined): string {
    const s = (raw ?? '').trim();
    if (!s) return '';
    let u: URL;
    try {
      u = new URL(s.startsWith('//') ? `https:${s}` : s);
    } catch {
      return '';
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (host === this.siteHost || this.aliases.includes(host)) {
      u.hostname = this.siteHost;
      u.protocol = 'https:';
      u.port = '';
    }
    return u.toString();
  }

  /** Same file without WordPress' `-scaled` suffix (the original upload, U9/D9). */
  static unscaled(url: string): string {
    return url.replace(/-scaled(\.[a-z0-9]{2,5})(?=$|[?#])/i, '$1');
  }

  fromUrl(
    raw: string | null | undefined,
    extra?: Partial<NMediaRef>,
  ): NMediaRef | null {
    const url = this.normalizeUrl(raw);
    if (!url) return null;
    const candidates = dedupe([MediaRefResolver.unscaled(url), url]);
    return { url, candidates, ...extra };
  }

  fromAttachment(
    idRaw: string | number | null | undefined,
    context?: { external_ref?: string },
  ): NMediaRef | null {
    const id =
      typeof idRaw === 'number'
        ? idRaw
        : Number.parseInt(String(idRaw ?? ''), 10);
    if (!Number.isFinite(id) || id <= 0) return null;
    const ext_id = this.ref('attachment', id);
    const att = this.tables.attachments.get(id);
    if (!att) {
      if (!this.missingReported.has(id)) {
        this.missingReported.add(id);
        this.issues.push({
          level: 'warn',
          code: 'W_MEDIA_MISSING_IN_BUNDLE',
          message: `Attachment ${id} is referenced but not in the bundle`,
          external_ref: context?.external_ref,
          data: { attachment_id: id },
        });
      }
      return { ext_id, url: '', candidates: [], missing: true };
    }
    const fromFile = att.attached_file
      ? this.joinUploads(att.attached_file)
      : '';
    const url = fromFile || this.normalizeUrl(att.guid);
    const candidates: string[] = [];
    const meta = att.metadata as {
      file?: unknown;
      original_image?: unknown;
    } | null;
    if (
      meta &&
      typeof meta.original_image === 'string' &&
      meta.original_image
    ) {
      const file =
        typeof meta.file === 'string' ? meta.file : (att.attached_file ?? '');
      const dir = file.includes('/')
        ? file.slice(0, file.lastIndexOf('/') + 1)
        : '';
      candidates.push(this.joinUploads(dir + meta.original_image));
    }
    if (url) candidates.push(MediaRefResolver.unscaled(url), url);
    return {
      ext_id,
      url,
      candidates: dedupe(candidates.filter(Boolean)),
      alt: att.alt ?? null,
      mime: att.mime ?? null,
      ...(url ? {} : { missing: true }),
    };
  }

  private joinUploads(rel: string): string {
    const clean = rel.replace(/^\/+/, '');
    if (/^https?:\/\//i.test(clean)) return this.normalizeUrl(clean);
    return this.normalizeUrl(
      this.uploadsBase.replace(/\/*$/, '/') +
        clean.split('/').map(encodeURIComponent).join('/'),
    );
  }
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}
