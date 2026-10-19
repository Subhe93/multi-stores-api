/**
 * Private storage keys of the designer app (M4.5 C10, namespace `designer/`):
 *
 *   designer/<storeId>/<yyyy>/<dir>/<id>[-<suffix>].<ext>
 *
 * The pattern is enforced by `PRIVATE_STORAGE_KEY_PATTERNS.designer` in
 * `common/storage/private-file-storage.ts`; this module only builds keys.
 * `<yyyy>` is the year the file was written (retention walks by row, never by
 * directory, so the year is informational and keeps directories small).
 */
import type { DesignAssetKind } from '@prisma/client';
import { UUID_RE } from './designs.util';

export const DESIGNER_FILE_DIRS = [
  'photo',
  'photo-preview',
  'bg-web',
  'bg-print',
  'deco',
  'thumb',
  'font',
  'proof',
  'print',
] as const;
export type DesignerFileDir = (typeof DESIGNER_FILE_DIRS)[number];

export const DESIGNER_FILE_EXTS = [
  'jpg',
  'png',
  'webp',
  'woff2',
  'ttf',
  'otf',
  // Print PDF (print files only; never an uploaded asset).
  'pdf',
] as const;
export type DesignerFileExt = (typeof DESIGNER_FILE_EXTS)[number];

/** Directory of an asset's canonical bytes. */
export const ASSET_KIND_DIR: Record<DesignAssetKind, DesignerFileDir> = {
  CUSTOMER_PHOTO: 'photo',
  TEMPLATE_BG_WEB: 'bg-web',
  TEMPLATE_BG_PRINT: 'bg-print',
  TEMPLATE_DECO: 'deco',
  TEMPLATE_THUMB: 'thumb',
  FONT: 'font',
};

export const MIME_BY_EXT: Record<DesignerFileExt, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
};

const EXT_BY_MIME: Record<string, DesignerFileExt> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'font/otf': 'otf',
  'application/pdf': 'pdf',
};

/** File extension for a stored mime type, or null when it is not a designer type. */
export function extForMime(mime: string): DesignerFileExt | null {
  return EXT_BY_MIME[mime] ?? null;
}

/** File extension of a storage key, or null. */
export function extOfKey(key: string): DesignerFileExt | null {
  const m = /\.([a-z0-9]+)$/.exec(key);
  return m && (DESIGNER_FILE_EXTS as readonly string[]).includes(m[1])
    ? (m[1] as DesignerFileExt)
    : null;
}

/**
 * Builds a key. `id` and `storeId` must be lowercase uuids, `suffix`
 * (e.g. the print surface `front`) 1–16 lowercase letters.
 */
export function designerStorageKey(
  storeId: string,
  dir: DesignerFileDir,
  id: string,
  ext: DesignerFileExt,
  opts: { at?: Date; suffix?: string } = {},
): string {
  if (!UUID_RE.test(storeId) || !UUID_RE.test(id)) {
    throw new Error('designerStorageKey: store id and file id must be uuids');
  }
  if (opts.suffix !== undefined && !/^[a-z]{1,16}$/.test(opts.suffix)) {
    throw new Error('designerStorageKey: invalid suffix');
  }
  const year = (opts.at ?? new Date()).getUTCFullYear();
  const name = opts.suffix ? `${id}-${opts.suffix}` : id;
  return `designer/${storeId}/${year}/${dir}/${name}.${ext}`;
}
