/**
 * Self-hosted fonts of the designer app (M4.2 WP3, D8/U11).
 *
 * NPP loaded the Google families of a template from fonts.googleapis.com at
 * render time. Here every face (family + weight + style) is a `DesignAsset`
 * of kind FONT whose file the creator uploads once per store; the storefront
 * editor, the dashboard preview and the server renderer (WP5) all load the
 * SAME bytes through `FontFace`, so text is measured identically everywhere.
 * Nothing is ever fetched from Google at runtime (no network dependency, no
 * visitor IP sent to Google).
 *
 * How the creator/admin gets the files (Google Fonts are OFL/Apache licensed
 * and may be self-hosted):
 * 1. Open https://fonts.google.com/specimen/<Family> (e.g. Montserrat),
 *    "Get font" → "Download all". The zip holds `static/<Family>-<Style>.ttf`
 *    (one file per weight/style) next to a variable font; use the static
 *    files. Alternatively google-webfonts-helper (gwfh.mranftl.com) offers
 *    per-weight woff2 files (latin + latin-ext), which are ~3× smaller.
 * 2. Upload each face the templates use in Designer → Fonts
 *    (`POST /api/designer/my/fonts`, multipart `file` + `family`, `weight`,
 *    `style`). When family/weight/style are omitted they are read from a
 *    Google-style file name: `Montserrat-SemiBoldItalic.ttf` → Montserrat,
 *    600, italic (`guessFaceFromFilename`).
 * 3. The family name must be exactly the one the template uses (NPP's
 *    `fontFamily`, e.g. "Montserrat", "Anton", "Righteous").
 * The NPP templates of namez need Montserrat 400/500/600/700, Anton 400 and
 * Righteous 400 (see `KNOWN_GOOGLE_WEIGHTS` in npp/npp-converter.ts).
 *
 * Accepted files: woff2, ttf and otf, checked by magic bytes and a
 * structural sanity check of the table directory (not by extension or the
 * client's mime). Max 10 MB per face.
 *
 * Built on by: WP4 (`fontsForSpec` → storefront payload), WP5 (`fontFiles`
 * → renderer page), WP7 (`resolveFaces` → `pending:font:*` placeholders).
 */
import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { DesignAssetKind, type DesignAsset } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { designerErrors } from './designer-errors';
import {
  DesignerAssetsService,
  type DesignerFileBody,
} from './designer-assets.service';
import { extForMime } from './designer-assets.keys';
import {
  CodePointSet,
  fontCodePoints,
  uncoveredCodePoints,
} from './designer-fonts.cmap';
import { designerFontPath } from './designer-urls';
import { resolveText, type TemplateSpecV1 } from './render/design-renderer';

export const FONT_MAX_BYTES = 10 * 1024 * 1024;
export const FONT_MIN_BYTES = 256;
/** Parsed cmap coverages kept in memory (a FONT asset never changes). */
export const FONT_COVERAGE_CACHE_MAX = 64;

/** A text whose face lacks some of its code points (rule `chars`). */
export interface UncoveredText {
  element_id: string;
  /** The face that was checked. */
  asset_id: string;
  /** Code points the face cannot draw (first few). */
  code_points: number[];
}

export type FontFormat = 'woff2' | 'ttf' | 'otf';
export type FontStyle = 'normal' | 'italic';

export interface FontFace {
  family: string;
  weight: number;
  style: FontStyle;
}

export interface DesignerFontView extends FontFace {
  id: string;
  format: FontFormat;
  bytes: number;
  sha256: string;
  /** Stable public path `/api/designer/fonts/<id>.<ext>`. */
  url: string;
  created_at: Date;
  /** A newer upload of the same face exists (this one stays for old versions). */
  superseded: boolean;
}

/** Bytes for the server renderer (WP5). */
export interface DesignerFontFile extends FontFace {
  asset_id: string;
  format: FontFormat;
  mime: string;
  data: Buffer;
}

/** Google family names: letters, digits, spaces and dashes (e.g. "M PLUS 1p"). */
const FAMILY_RE = /^[A-Za-z0-9][A-Za-z0-9 -]{0,62}[A-Za-z0-9]$|^[A-Za-z0-9]$/;

/** Google Fonts weight names (file name suffixes). */
const WEIGHT_NAMES: [string, number][] = [
  ['extralight', 200],
  ['ultralight', 200],
  ['semibold', 600],
  ['demibold', 600],
  ['extrabold', 800],
  ['ultrabold', 800],
  ['thin', 100],
  ['hairline', 100],
  ['light', 300],
  ['regular', 400],
  ['normal', 400],
  ['book', 400],
  ['medium', 500],
  ['bold', 700],
  ['black', 900],
  ['heavy', 900],
];

/**
 * Detects the font format by magic bytes and checks the table directory
 * (pure). Returns null for anything that is not a plausible woff2/ttf/otf.
 */
export function detectFontFormat(buf: Buffer): FontFormat | null {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  const tag = buf.readUInt32BE(0);
  if (tag === 0x774f4632) {
    // 'wOF2': 48-byte header; `length` (offset 8) is the total file size.
    if (buf.length < 48) return null;
    const flavor = buf.readUInt32BE(4);
    const length = buf.readUInt32BE(8);
    const numTables = buf.readUInt16BE(12);
    if (
      length !== buf.length ||
      numTables < 1 ||
      numTables > 128 ||
      ![0x00010000, 0x4f54544f, 0x74727565].includes(flavor)
    ) {
      return null;
    }
    return 'woff2';
  }
  const isTtf = tag === 0x00010000 || tag === 0x74727565; // 1.0 / 'true'
  const isOtf = tag === 0x4f54544f; // 'OTTO'
  if (!isTtf && !isOtf) return null;
  const numTables = buf.readUInt16BE(4);
  if (numTables < 1 || numTables > 128 || buf.length < 12 + numTables * 16) {
    return null;
  }
  const tags = new Set<string>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    const t = buf.toString('latin1', rec, rec + 4);
    const offset = buf.readUInt32BE(rec + 8);
    const len = buf.readUInt32BE(rec + 12);
    if (offset + len > buf.length) return null;
    tags.add(t);
  }
  for (const required of ['cmap', 'head', 'name']) {
    if (!tags.has(required)) return null;
  }
  if (isTtf && !tags.has('glyf')) return null;
  if (isOtf && !tags.has('CFF ') && !tags.has('CFF2')) return null;
  return isOtf ? 'otf' : 'ttf';
}

/**
 * Reads family / weight / style from a Google-style file name
 * (`Montserrat-SemiBoldItalic.ttf`, `Anton-Regular.ttf`,
 * `montserrat-v26-latin-600.woff2`). Missing parts are null.
 */
export function guessFaceFromFilename(name: string | undefined | null): {
  family: string | null;
  weight: number | null;
  style: FontStyle | null;
} {
  const base = String(name ?? '')
    .replace(/^.*[\\/]/, '')
    .replace(/\.(woff2|ttf|otf)$/i, '');
  if (!base) return { family: null, weight: null, style: null };
  // gwfh: <family>-v<rev>-<subsets>-<weight|regular|italic|700italic>
  const gwfh =
    /^([a-z0-9-]+?)-v\d+-[a-z0-9_-]+-(\d{3}|regular|italic)(italic)?$/i.exec(
      base,
    );
  if (gwfh) {
    const family = gwfh[1]
      .split('-')
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
    const token = gwfh[2].toLowerCase();
    const weight = /^\d{3}$/.test(token) ? Number(token) : 400;
    const italic = token === 'italic' || !!gwfh[3];
    return { family, weight, style: italic ? 'italic' : 'normal' };
  }
  const dash = base.lastIndexOf('-');
  const familyPart = dash > 0 ? base.slice(0, dash) : base;
  const stylePart = dash > 0 ? base.slice(dash + 1).toLowerCase() : '';
  // "OpenSans" → "Open Sans"; keep "M PLUS" style names untouched.
  const family = familyPart.includes(' ')
    ? familyPart
    : familyPart.replace(/([a-z])([A-Z])/g, '$1 $2');
  let weight: number | null = null;
  let rest = stylePart;
  const italic = /italic$/.test(rest);
  if (italic) rest = rest.replace(/italic$/, '');
  if (rest === '' && (italic || stylePart === '')) weight = italic ? 400 : null;
  for (const [w, n] of WEIGHT_NAMES) {
    if (rest === w) {
      weight = n;
      break;
    }
  }
  return {
    family: family || null,
    weight,
    style: stylePart ? (italic ? 'italic' : 'normal') : null,
  };
}

/** Validates and normalises a face; throws DESIGNER_FONT_INVALID. */
export function normalizeFace(input: {
  family?: unknown;
  weight?: unknown;
  style?: unknown;
}): FontFace {
  const family =
    typeof input.family === 'string'
      ? input.family.trim().replace(/\s+/g, ' ')
      : '';
  const weight = Number(input.weight);
  const style = input.style === undefined ? 'normal' : input.style;
  const problems: string[] = [];
  if (!FAMILY_RE.test(family)) problems.push('family');
  if (!Number.isInteger(weight) || weight < 1 || weight > 1000) {
    problems.push('weight');
  }
  if (style !== 'normal' && style !== 'italic') problems.push('style');
  if (problems.length) {
    throw designerErrors.badRequest(
      'DESIGNER_FONT_INVALID',
      'Give the font family (letters, digits, spaces, dashes), a weight from 1 to 1000 and the style normal or italic.',
      { fields: problems.join(',') },
    );
  }
  return { family, weight, style: style as FontStyle };
}

function faceKey(f: FontFace): string {
  return `${f.family.toLowerCase()}|${f.weight}|${f.style}`;
}

function faceOf(a: DesignAsset): (FontFace & { format: FontFormat }) | null {
  const m = a.meta as Record<string, unknown> | null;
  if (!m || typeof m.family !== 'string') return null;
  const ext = extForMime(a.mime);
  if (ext !== 'woff2' && ext !== 'ttf' && ext !== 'otf') return null;
  return {
    family: m.family,
    weight: Number(m.weight),
    style: m.style === 'italic' ? 'italic' : 'normal',
    format: ext,
  };
}

@Injectable()
export class DesignerFontsService {
  /** asset id → parsed coverage (null = unreadable: the check is skipped). */
  private readonly coverageCache = new Map<string, CodePointSet | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly assets: DesignerAssetsService,
  ) {}

  /**
   * Glyph coverage of a FONT asset of the store, parsed once and cached
   * (LRU by insertion, FONT_COVERAGE_CACHE_MAX entries). Null when the
   * asset is missing, purged or its cmap cannot be read.
   */
  async coverage(
    storeId: string,
    assetId: string,
  ): Promise<CodePointSet | null> {
    const hit = this.coverageCache.get(assetId);
    if (hit !== undefined) {
      // Refresh the insertion order (LRU).
      this.coverageCache.delete(assetId);
      this.coverageCache.set(assetId, hit);
      return hit;
    }
    const rows = await this.assets.findOwnedAssets(
      storeId,
      [assetId],
      [DesignAssetKind.FONT],
    );
    const a = rows.get(assetId);
    if (!a) return null;
    const set = fontCodePoints(await this.assets.readAssetBytes(a));
    if (this.coverageCache.size >= FONT_COVERAGE_CACHE_MAX) {
      const oldest = this.coverageCache.keys().next().value as
        | string
        | undefined;
      if (oldest !== undefined) this.coverageCache.delete(oldest);
    }
    this.coverageCache.set(assetId, set);
    return set;
  }

  /**
   * Save / cart check (§6.4): every code point of each customer text (as
   * drawn: the element's transform applied) must be in the cmap of the
   * face's uploaded file. Emoji / pictographs are exempt (host fallback
   * font). Faces whose file is missing or unreadable are skipped (the
   * render fails those loudly as RENDER_MISSING / FONT_LOAD_FAILED).
   */
  async uncoveredTexts(
    storeId: string,
    spec: TemplateSpecV1,
    texts: Record<string, string>,
  ): Promise<UncoveredText[]> {
    const out: UncoveredText[] = [];
    const surface = (spec?.surfaces ?? []).find((s) => s.key === 'front');
    if (!surface) return out;
    const faces = spec.fonts ?? [];
    for (const el of surface.elements ?? []) {
      if (el.type !== 'text' || !el.editable) continue;
      const raw = texts[el.id];
      if (typeof raw !== 'string' || raw === '') continue;
      const face = faces.find(
        (f) =>
          f.family === el.font.family &&
          f.weight === el.font.weight &&
          (f.style || 'normal') === (el.font.style || 'normal'),
      );
      if (!face?.asset_id) continue;
      const set = await this.coverage(storeId, face.asset_id);
      if (!set) continue;
      const drawn = resolveText(el, {
        v: 1,
        texts: { [el.id]: raw },
        photos: {},
      });
      const missing = uncoveredCodePoints(drawn, set);
      if (missing.length) {
        out.push({
          element_id: el.id,
          asset_id: face.asset_id,
          code_points: missing.slice(0, 8),
        });
      }
    }
    return out;
  }

  /**
   * Registers one face from an uploaded file. The same bytes for the same
   * face return the existing asset (`deduped`); a different file for an
   * existing face becomes the new current face (`replaced` lists the older
   * ids, which stay for template versions that reference them).
   */
  async registerFont(
    storeId: string,
    buffer: Buffer,
    input: {
      family?: unknown;
      weight?: unknown;
      style?: unknown;
      filename?: string | null;
      subsets?: string[];
    },
  ): Promise<{ font: DesignerFontView; deduped: boolean; replaced: string[] }> {
    if (!buffer?.length || buffer.length < FONT_MIN_BYTES) {
      throw designerErrors.badRequest(
        'DESIGNER_UPLOAD_TYPE',
        'Upload a font file (woff2, ttf or otf).',
        { allowed: 'woff2,ttf,otf' },
      );
    }
    if (buffer.length > FONT_MAX_BYTES) {
      throw designerErrors.tooLarge('The font file is too large.', {
        max_mb: FONT_MAX_BYTES / (1024 * 1024),
      });
    }
    const format = detectFontFormat(buffer);
    if (!format) {
      throw designerErrors.badRequest(
        'DESIGNER_UPLOAD_TYPE',
        'Upload a font file (woff2, ttf or otf).',
        { allowed: 'woff2,ttf,otf' },
      );
    }
    const guess = guessFaceFromFilename(input.filename);
    const face = normalizeFace({
      family: input.family ?? guess.family ?? undefined,
      weight: input.weight ?? guess.weight ?? undefined,
      style: input.style ?? guess.style ?? undefined,
    });
    const hash = createHash('sha256').update(buffer).digest('hex');

    const existing = await this.activeFonts(storeId);
    const same = existing.filter((a) => {
      const f = faceOf(a);
      return f && faceKey(f) === faceKey(face);
    });
    const identical = same.find((a) => a.sha256 === hash);
    if (identical) {
      return {
        font: this.view(identical, false),
        deduped: true,
        replaced: [],
      };
    }
    const subsets = (input.subsets ?? []).filter((s) =>
      /^[a-z0-9-]{1,24}$/.test(s),
    );
    const row = await this.assets.writeRawAsset(storeId, {
      kind: DesignAssetKind.FONT,
      data: buffer,
      ext: format,
      sha256: hash,
      meta: {
        family: face.family,
        weight: face.weight,
        style: face.style,
        format,
        ...(subsets.length ? { subsets } : {}),
        ...(same.length ? { supersedes: same.map((a) => a.id) } : {}),
      },
    });
    return {
      font: this.view(row, false),
      deduped: false,
      replaced: same.map((a) => a.id),
    };
  }

  /** Every face of the store, newest first within a face. */
  async listFonts(storeId: string): Promise<DesignerFontView[]> {
    const rows = await this.activeFonts(storeId);
    const seen = new Set<string>();
    const out: DesignerFontView[] = [];
    for (const a of rows) {
      const f = faceOf(a);
      if (!f) continue;
      const k = faceKey(f);
      out.push(this.view(a, seen.has(k)));
      seen.add(k);
    }
    return out.sort(
      (x, y) =>
        x.family.localeCompare(y.family) ||
        x.weight - y.weight ||
        x.style.localeCompare(y.style) ||
        Number(x.superseded) - Number(y.superseded),
    );
  }

  /**
   * Current asset per requested face (newest upload wins). WP7 maps the
   * converter's `pending:font:<family>:<weight>:<style>` placeholders with it;
   * `missing` lists the faces the creator still has to upload.
   */
  async resolveFaces(
    storeId: string,
    needs: FontFace[],
  ): Promise<{
    found: Map<string, { asset_id: string } & FontFace>;
    missing: FontFace[];
  }> {
    const current = new Map<string, DesignAsset>();
    for (const a of await this.activeFonts(storeId)) {
      const f = faceOf(a);
      if (f && !current.has(faceKey(f))) current.set(faceKey(f), a);
    }
    const found = new Map<string, { asset_id: string } & FontFace>();
    const missing: FontFace[] = [];
    for (const n of needs) {
      const a = current.get(faceKey(n));
      if (a) found.set(faceKey(n), { asset_id: a.id, ...n });
      else missing.push(n);
    }
    return { found, missing };
  }

  /**
   * Public font list of a spec (WP4 storefront payload): one entry per
   * `spec.fonts[]` asset that exists in the store, with its public path.
   */
  async fontsForSpec(
    storeId: string,
    spec: { fonts?: { asset_id: string }[] } | null | undefined,
  ): Promise<(FontFace & { asset_id: string; url: string })[]> {
    const ids = (spec?.fonts ?? []).map((f) => f.asset_id);
    const rows = await this.assets.findOwnedAssets(storeId, ids, [
      DesignAssetKind.FONT,
    ]);
    const out: (FontFace & { asset_id: string; url: string })[] = [];
    for (const id of ids) {
      const a = rows.get(id);
      const f = a && faceOf(a);
      if (!a || !f) continue;
      out.push({
        asset_id: a.id,
        family: f.family,
        weight: f.weight,
        style: f.style,
        url: designerFontPath(a.id, f.format),
      });
    }
    return out;
  }

  /** Font bytes for the server renderer (WP5); `assetIds` limits the set. */
  async fontFiles(
    storeId: string,
    assetIds?: string[],
  ): Promise<DesignerFontFile[]> {
    const rows = assetIds
      ? [
          ...(
            await this.assets.findOwnedAssets(storeId, assetIds, [
              DesignAssetKind.FONT,
            ])
          ).values(),
        ]
      : await this.activeFonts(storeId);
    const out: DesignerFontFile[] = [];
    for (const a of rows) {
      const f = faceOf(a);
      if (!f) continue;
      out.push({
        asset_id: a.id,
        family: f.family,
        weight: f.weight,
        style: f.style,
        format: f.format,
        mime: a.mime,
        data: await this.assets.readAssetBytes(a),
      });
    }
    return out;
  }

  /**
   * Public font route (`GET designer/fonts/<id>.<ext>`): a FONT asset whose
   * extension matches, while the designer app is enabled for its store.
   */
  async readPublicFont(id: string, ext: string): Promise<DesignerFileBody> {
    const { buffer, mime, sha256 } = await this.assets.readPublicAsset(
      id,
      ext,
      [DesignAssetKind.FONT],
    );
    return { buffer, mime, sha256 };
  }

  private activeFonts(storeId: string): Promise<DesignAsset[]> {
    return this.prisma.designAsset.findMany({
      where: { store_id: storeId, kind: DesignAssetKind.FONT, purged_at: null },
      orderBy: { created_at: 'desc' },
    });
  }

  private view(a: DesignAsset, superseded: boolean): DesignerFontView {
    const f = faceOf(a);
    const format: FontFormat = f?.format ?? 'woff2';
    return {
      id: a.id,
      family: f?.family ?? '',
      weight: f?.weight ?? 400,
      style: f?.style ?? 'normal',
      format,
      bytes: a.bytes,
      sha256: a.sha256,
      url: designerFontPath(a.id, format),
      created_at: a.created_at,
      superseded,
    };
  }
}
