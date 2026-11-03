import * as fs from 'fs';
import * as path from 'path';
import { randomUUID } from 'crypto';
import type { Kit } from './kits/types';
import type { PublicStorage } from '../storage/public-storage';

// Where bundled kit assets live (committed app code, read from disk). The
// copies are written through PublicStorage (local disk or S3 by driver).
const ASSETS_ROOT = path.join(process.cwd(), 'assets', 'templates');

const PLACEHOLDER_PALETTE: Array<[string, string]> = [
  ['#0f172a', '#334155'],
  ['#f97316', '#be123c'],
  ['#4f46e5', '#7c3aed'],
  ['#0d9488', '#0e7490'],
  ['#db2777', '#9333ea'],
];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}

// Generated fallback so a kit renders with real image URLs even before its
// photography is dropped into the assets folder. A simple branded gradient
// tile; avatars (testi-*) get a circular crop hint.
function placeholderSvg(key: string): string {
  const [a, b] = PLACEHOLDER_PALETTE[hash(key) % PLACEHOLDER_PALETTE.length];
  const isAvatar = key.startsWith('testi');
  const shape = isAvatar
    ? '<circle cx="600" cy="400" r="320" fill="rgba(255,255,255,0.12)"/>'
    : '<rect x="0" y="0" width="1200" height="800" fill="url(#g)"/>';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800" preserveAspectRatio="xMidYMid slice">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0" stop-color="${a}"/><stop offset="1" stop-color="${b}"/></linearGradient></defs>
<rect width="1200" height="800" fill="${a}"/>${shape}
</svg>`;
}

/**
 * Materialise a kit's assets into the store's uploads
 * (`/uploads/template-imports/<storeId>/<uuid>.<ext>`) and return an
 * assetKey → URL map for substitution into section settings/content. Bundled
 * files (assets/templates/<kitId>/<file>) are copied byte-for-byte through
 * `PublicStorage`; any missing file falls back to a generated gradient SVG so
 * the import never leaves broken images. Storage work — call before the DB
 * transaction.
 */
export async function materialiseKitAssets(
  kit: Kit,
  storeId: string,
  storage: PublicStorage,
): Promise<Record<string, string>> {
  const srcDir = path.join(ASSETS_ROOT, kit.id);
  const map: Record<string, string> = {};

  for (const [key, asset] of Object.entries(kit.assets)) {
    try {
      const src = path.resolve(srcDir, asset.file);
      // Guard against path escaping the kit's asset dir (defensive — kit data
      // is trusted, but keep it tight).
      const useBundled =
        src.startsWith(path.resolve(srcDir) + path.sep) && fs.existsSync(src);

      const ext = useBundled
        ? path.extname(asset.file).toLowerCase() || '.svg'
        : '.svg';
      const filename = `${randomUUID()}${ext}`;
      const body = useBundled
        ? await fs.promises.readFile(src)
        : Buffer.from(placeholderSvg(key), 'utf8');
      const stored = await storage.put(
        `template-imports/${storeId}`,
        filename,
        body,
      );
      map[key] = stored.url;
    } catch {
      // Leave unmapped → substitution resolves to '' and sections show their
      // empty state rather than failing the whole import.
      map[key] = '';
    }
  }

  return map;
}
