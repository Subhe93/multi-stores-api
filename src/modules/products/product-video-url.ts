// Strict YouTube / Vimeo URL parser shared by the product DTO and the
// video-link endpoint. Unknown hosts or shapes return null: never iframe a
// generic URL.
export type ExternalVideoKind = 'youtube' | 'vimeo';

export interface ParsedExternalVideo {
  kind: ExternalVideoKind;
  id: string;
  /** Vimeo unlisted-video hash, when present. */
  hash?: string;
  canonicalUrl: string;
}

const YT_ID = /^[A-Za-z0-9_-]{11}$/;
const VIMEO_ID = /^\d{1,12}$/;
const VIMEO_HASH = /^[A-Za-z0-9]{6,20}$/;

function youtube(id: string | null | undefined): ParsedExternalVideo | null {
  return id && YT_ID.test(id)
    ? {
        kind: 'youtube',
        id,
        canonicalUrl: `https://www.youtube.com/watch?v=${id}`,
      }
    : null;
}

function vimeo(
  id: string | undefined,
  hash: string | null | undefined,
): ParsedExternalVideo | null {
  if (!id || !VIMEO_ID.test(id)) return null;
  if (hash && !VIMEO_HASH.test(hash)) return null;
  return hash
    ? {
        kind: 'vimeo',
        id,
        hash,
        canonicalUrl: `https://vimeo.com/${id}/${hash}`,
      }
    : { kind: 'vimeo', id, canonicalUrl: `https://vimeo.com/${id}` };
}

export function parseExternalVideoUrl(raw: string): ParsedExternalVideo | null {
  let u: URL;
  try {
    u = new URL(String(raw ?? '').trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const parts = u.pathname.split('/').filter(Boolean);

  if (
    host === 'youtube.com' ||
    host === 'm.youtube.com' ||
    host === 'youtube-nocookie.com'
  ) {
    if (parts.length === 1 && parts[0] === 'watch')
      return youtube(u.searchParams.get('v'));
    if (parts.length === 2 && ['embed', 'shorts', 'live'].includes(parts[0]))
      return youtube(parts[1]);
    return null;
  }
  if (host === 'youtu.be') return parts.length === 1 ? youtube(parts[0]) : null;
  if (host === 'vimeo.com') {
    if (parts.length === 1) return vimeo(parts[0], null);
    if (parts.length === 2) return vimeo(parts[0], parts[1]);
    return null;
  }
  if (host === 'player.vimeo.com') {
    return parts.length === 2 && parts[0] === 'video'
      ? vimeo(parts[1], u.searchParams.get('h'))
      : null;
  }
  return null;
}
