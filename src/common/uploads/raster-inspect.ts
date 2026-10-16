/**
 * Raster inspection shared by customer uploads (M4.0), designer photos (M4.2)
 * and importer media (M4.4) — M4.5 contract C20.
 *
 * Reads only the image header through sharp (no full decode), checks the
 * caller's limits and returns the basic facts. Each caller keeps its own
 * processing policy; this helper never transforms the image.
 */
import sharp from 'sharp';

export type RasterInspectErrorCode =
  | 'RASTER_UNDECODABLE'
  | 'RASTER_FORMAT_NOT_ALLOWED'
  | 'RASTER_TOO_MANY_PIXELS'
  | 'RASTER_TOO_SMALL'
  | 'RASTER_TOO_LARGE'
  | 'RASTER_ANIMATED';

export class RasterInspectError extends Error {
  constructor(
    readonly code: RasterInspectErrorCode,
    readonly params: Record<string, number | string> = {},
  ) {
    super(`${code} ${JSON.stringify(params)}`);
    this.name = 'RasterInspectError';
  }
}

export interface RasterInspectOptions {
  /** Max width × height (of one frame). */
  maxPixels: number;
  /** Minimum length of the shorter side. */
  minShortSide?: number;
  /** Maximum length of the longer side. */
  maxSide?: number;
  /** Default false: multi-frame images are rejected. */
  allowAnimated?: boolean;
  /** Allowed sharp formats; default jpeg, png, webp. */
  formats?: readonly string[];
}

export interface RasterInfo {
  /** sharp format name: `jpeg`, `png`, `webp`, ... */
  format: string;
  width: number;
  height: number;
  /** Number of frames (1 for still images). */
  pages: number;
}

export const DEFAULT_RASTER_FORMATS: readonly string[] = [
  'jpeg',
  'png',
  'webp',
];

/** Inspects a raster buffer; throws `RasterInspectError` when it fails a check. */
export async function inspectRaster(
  buf: Buffer,
  opts: RasterInspectOptions,
): Promise<RasterInfo> {
  let meta: sharp.Metadata;
  try {
    // limitInputPixels: false here because the pixel limit is checked below
    // with a coded error; metadata() reads the header only.
    meta = await sharp(buf, { limitInputPixels: false }).metadata();
  } catch {
    throw new RasterInspectError('RASTER_UNDECODABLE');
  }
  const format = String(meta.format ?? '');
  const width = meta.width ?? 0;
  // For animated images sharp reports the frame height as pageHeight.
  const height = meta.pageHeight ?? meta.height ?? 0;
  const pages = meta.pages ?? 1;
  if (!format || !width || !height) {
    throw new RasterInspectError('RASTER_UNDECODABLE');
  }
  const formats = opts.formats ?? DEFAULT_RASTER_FORMATS;
  if (!formats.includes(format)) {
    throw new RasterInspectError('RASTER_FORMAT_NOT_ALLOWED', { format });
  }
  if (!opts.allowAnimated && pages > 1) {
    throw new RasterInspectError('RASTER_ANIMATED', { pages });
  }
  if (width * height > opts.maxPixels) {
    throw new RasterInspectError('RASTER_TOO_MANY_PIXELS', {
      max_pixels: opts.maxPixels,
      width,
      height,
    });
  }
  if (opts.maxSide && Math.max(width, height) > opts.maxSide) {
    throw new RasterInspectError('RASTER_TOO_LARGE', {
      max_side: opts.maxSide,
      width,
      height,
    });
  }
  if (opts.minShortSide && Math.min(width, height) < opts.minShortSide) {
    throw new RasterInspectError('RASTER_TOO_SMALL', {
      min_short_side: opts.minShortSide,
      width,
      height,
    });
  }
  return { format, width, height, pages };
}
