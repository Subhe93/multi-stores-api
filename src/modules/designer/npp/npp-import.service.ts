/**
 * NPP template import (M4.2 WP7, §10, M4-INTEGRATION C26).
 *
 * Flow per template the converter includes:
 *  1. `convertNpp` → spec with `pending:*` placeholders + the URLs to fetch;
 *  2. asset bytes: the importer's private copy (`importer/…`, keyed by source
 *     URL) is read and COPIED into `designer/…`; anything else is fetched
 *     through the importer's SSRF-safe, host-locked `SafeFetcher` (never a raw
 *     fetch), original first and the `-scaled` file as fallback (U9). With
 *     `fetchMedia: false` nothing is fetched: missing assets stay pending;
 *  3. the real dimensions are probed, `finalizeTemplateAssets` decides the
 *     BG swap / low-res warnings, and only then each file is stored with the
 *     kind of its FINAL role (a swapped web background must be public);
 *  4. fonts are mapped to the store's uploaded faces (`resolveFaces`);
 *     missing faces stay `pending:font:*` with a FONTS_MISSING warning that
 *     names the files to upload;
 *  5. `DesignTemplate` (DRAFT, source `npp`, `external_ref`
 *     `woo:<host>:npp_template:<id>`) + an immutable `DesignTemplateVersion`.
 *     Re-runs are idempotent: identical bytes dedupe to the same asset ids,
 *     so an identical spec (sha256) is UNCHANGED and creates no version;
 *  6. product links (`ProductDesigner{enabled:false}`, add-ons always
 *     disabled, D9) for the direct JSON path; the importer links through the
 *     port's `linkProduct` inside its own transaction.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  DesignAssetKind,
  Prisma,
  type DesignTemplate,
  type DesignTemplateVersion,
} from '@prisma/client';
import sharp from 'sharp';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  PRIVATE_STORAGE,
  type PrivateStorage,
} from '../../../common/storage/private-file-storage';
import type { DesignerImportMedia } from '../../../common/ports/designer-import.port';
import {
  SafeFetcher,
  type SafeFetchOptions,
  type SafeFetchResponse,
} from '../../importer/media/safe-fetch';
import { sniffImage } from '../../importer/media/sniff';
import type { AssetRef, TemplateSpecV1 } from '../render/design-renderer';
import {
  DesignerAssetsService,
  TEMPLATE_ASSET_MAX_BYTES,
  TEMPLATE_RASTER_LIMITS,
  type AssetWarningCode,
} from '../designer-assets.service';
import { isAddonsV2 } from '../designer-addons';
import { DesignerFontsService, type FontFace } from '../designer-fonts.service';
import {
  convertNpp,
  finalizeTemplateAssets,
  type NppConvertedTemplate,
  type NppFetch,
  type NppMediaInfo,
  type NppProductLink,
  type NppWarningCode,
} from './npp-converter';

/* ------------------------------------------------------------------ */
/* Warning codes (dashboard i18n: creator.designer.importWarnings.<code>) */
/* ------------------------------------------------------------------ */

export type NppImportWarningCode =
  | Exclude<NppWarningCode, 'ASSET_MISSING'>
  | Exclude<AssetWarningCode, 'PRINT_BG_LOW_RES'>
  | 'MEDIA_SKIPPED'
  | 'ASSET_FETCH_FAILED'
  | 'ASSET_INVALID'
  | 'ASSET_REUSED'
  | 'FONTS_MISSING'
  | 'PRODUCT_NOT_FOUND'
  | 'PRODUCT_LINK_KEPT'
  | 'MERCHANT_EDITED'
  | 'NAME_KEPT';

/** Every code the import can report (converter + import + asset checks). */
export const NPP_IMPORT_WARNING_CODES = [
  // Converter (§10.2).
  'INPUT_UNRECOGNIZED',
  'TEMPLATE_NO_ELEMENTS',
  'TEMPLATE_CONFLICT',
  'TEMPLATE_UNLINKED',
  'NAME_REVIEW',
  'UNKNOWN_SIZE_MODE',
  'PREMIUM_ASSUMED_BLEED',
  'NO_BACKGROUND',
  'PRINT_BG_FROM_WEB',
  'PRINT_BG_SAME_AS_WEB',
  'BG_SCALED_FALLBACK',
  'BG_SWAPPED',
  'BG_SWAP_UNDECIDED',
  'PRINT_BG_LOW_RES',
  'LABEL_NORMALIZED',
  'LABEL_NOT_NORMALIZED',
  'FONT_UNDECLARED',
  'FONT_WEIGHT_SUBSTITUTED',
  'FONT_WEIGHTS_UNKNOWN',
  'FONT_CUSTOM_UNSUPPORTED',
  'UNSUPPORTED_ELEMENT',
  'ELEMENT_NO_IMAGE',
  'ID_REWRITTEN',
  'PRODUCT_SKIPPED',
  // Asset checks of storeTemplateAsset (WP3).
  'WEB_BG_LOW_RES',
  'ASPECT_MISMATCH',
  'WEB_BG_LARGE',
  'COLOR_CONVERTED',
  // Import (WP7).
  'MEDIA_SKIPPED',
  'ASSET_FETCH_FAILED',
  'ASSET_INVALID',
  'ASSET_REUSED',
  'FONTS_MISSING',
  'PRODUCT_NOT_FOUND',
  'PRODUCT_LINK_KEPT',
  // Re-import over merchant changes (M4.2 fixes).
  'MERCHANT_EDITED',
  'NAME_KEPT',
] as const satisfies readonly NppImportWarningCode[];

// Compile-time check: the list covers the whole union.
type MissingCodes = Exclude<
  NppImportWarningCode,
  (typeof NPP_IMPORT_WARNING_CODES)[number]
>;
const allCodesListed: MissingCodes extends never ? true : never = true;
void allCodesListed;

export interface NppImportWarning {
  code: NppImportWarningCode;
  template_id?: string;
  element_id?: string;
  message: string;
  data?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ */
/* Options and report                                                  */
/* ------------------------------------------------------------------ */

/** Importer media copy (C26) plus the candidate that succeeded, if known. */
export type NppImportMedia = DesignerImportMedia & {
  fetched_url?: string | null;
};

export interface NppMediaFetcher {
  get(url: string, opts: SafeFetchOptions): Promise<SafeFetchResponse>;
}

export interface NppImportOptions {
  /** Source host of the external refs (C7), e.g. `namez.se`. */
  siteHost: string;
  normalizeLabels?: boolean;
  /** Import templates no product uses (4410). Default false. */
  includeUnlinked?: boolean;
  /** NPP product ids that are not linked (U4: `4326`). */
  skipProductIds?: string[];
  locale?: string;
  /** Importer private copies keyed by source URL (C26). */
  media?: Map<string, NppImportMedia>;
  /** False (importer media scope off) ⇒ nothing is fetched. */
  fetchMedia: boolean;
  /** Safe fetcher override; default: `fetcherFor(storeId, siteHost)`. */
  fetcher?: NppMediaFetcher | null;
  /** Create `ProductDesigner` links from the converter output. Default true. */
  linkProducts?: boolean;
  /** User id stored on new versions (null for imports). */
  createdBy?: string | null;
}

export type NppTemplateAction =
  | 'CREATE'
  | 'UPDATE'
  | 'UNCHANGED'
  | 'SKIP'
  | 'ERROR';

export interface NppImportTemplateReport {
  source_id: string;
  external_ref: string;
  name: string;
  template_id: string | null;
  action: NppTemplateAction;
  version: number | null;
  pending_assets: string[];
  warnings: NppImportWarning[];
  error?: string;
}

export type NppLinkAction = 'CREATE' | 'UPDATE' | 'UNCHANGED' | 'SKIP';

export interface NppImportLinkReport {
  product_source_id: string;
  product_external_ref: string;
  product_id: string | null;
  template_external_ref: string;
  template_id: string | null;
  action: NppLinkAction;
}

export interface NppFontFileHint extends FontFace {
  /** Google static file name to upload, e.g. `Montserrat-SemiBold.ttf`. */
  file: string;
}

export interface NppImportReport {
  templates: NppImportTemplateReport[];
  links: NppImportLinkReport[];
  /** Union of the faces still to upload (Designer → Fonts). */
  missing_fonts: NppFontFileHint[];
  /** Warnings that belong to no single template (links, skipped products, input). */
  warnings: NppImportWarning[];
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const PROBE = 'probe:';
const PENDING = 'pending:';

const WEIGHT_FILE_NAMES: Record<number, string> = {
  100: 'Thin',
  200: 'ExtraLight',
  300: 'Light',
  400: 'Regular',
  500: 'Medium',
  600: 'SemiBold',
  700: 'Bold',
  800: 'ExtraBold',
  900: 'Black',
};

/** Google Fonts static file name of a face (`Montserrat-SemiBoldItalic.ttf`). */
export function googleFontFileName(f: FontFace): string {
  const base = WEIGHT_FILE_NAMES[f.weight] ?? String(f.weight);
  const style =
    f.style === 'italic'
      ? base === 'Regular'
        ? 'Italic'
        : `${base}Italic`
      : base;
  return `${f.family.replace(/\s+/g, '')}-${style}.ttf`;
}

/** JSON with sorted keys, so equal specs hash equally. */
export function stableJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableJson).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v);
}

export function specSha256(spec: TemplateSpecV1): string {
  return createHash('sha256').update(stableJson(spec)).digest('hex');
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const numOrNull = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
};

/**
 * NPP add-ons/pricing → `ProductDesigner.addons` (§10.2). Every add-on is
 * stored DISABLED (D9: never priced in M4.2); `source_enabled` keeps NPP's flag.
 */
export function normalizeNppAddons(
  addons: unknown,
  pricing: unknown,
): Record<string, unknown> {
  const a = isRecord(addons) ? addons : {};
  const p = isRecord(pricing) ? pricing : {};
  if (!Object.keys(a).length && !Object.keys(p).length) return {};
  const entry = (key: string, price: unknown, regular?: unknown) => {
    const out: Record<string, unknown> = {
      enabled: false,
      source_enabled: a[key] === true,
      price: numOrNull(price),
    };
    if (regular !== undefined) out.regular = numOrNull(regular);
    return out;
  };
  return {
    double: entry('double', p.double_extra),
    raincover: entry('raincover', p.rain_extra),
    poster: entry('poster', p.poster_price),
    welcome: entry('welcome', p.welcome_price, p.welcome_regular),
  };
}

/** Collapses alias hosts / `www.` / http so importer keys and NPP URLs match. */
function mediaKey(url: string, siteHost: string, aliases: string[]): string {
  try {
    const u = new URL(url.startsWith('//') ? `https:${url}` : url);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    u.hostname = aliases.includes(host) ? siteHost : host;
    u.protocol = 'https:';
    u.port = '';
    return u.toString();
  } catch {
    return url;
  }
}

type Bytes =
  | { ok: true; buf: Buffer; url: string; used_fallback: boolean }
  | { ok: false; reason: 'skipped' | 'failed'; message: string };

interface RunCtx {
  storeId: string;
  opts: NppImportOptions;
  aliases: string[];
  media: Map<string, NppImportMedia>;
  fetcher: () => Promise<NppMediaFetcher>;
  /** Fetch results per URL (several templates share files). */
  fetched: Map<string, Promise<Bytes>>;
}

type Tx = Prisma.TransactionClient;

@Injectable()
export class NppImportService {
  private readonly logger = new Logger(NppImportService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PRIVATE_STORAGE) private readonly storage: PrivateStorage,
    private readonly assets: DesignerAssetsService,
    private readonly fonts: DesignerFontsService,
  ) {}

  /** Host settings of the store's import source (aliases, uploads path). */
  async sourcePolicy(
    storeId: string,
    siteHost: string,
  ): Promise<{ aliases: string[]; uploadsPath?: string }> {
    const src = await this.prisma.importSource.findFirst({
      where: { store_id: storeId, site_host: siteHost.toLowerCase() },
      select: { host_aliases: true, settings: true },
    });
    const settings = isRecord(src?.settings) ? src.settings : {};
    return {
      aliases: (src?.host_aliases ?? []).map((a) => a.toLowerCase()),
      uploadsPath:
        typeof settings.uploads_path === 'string'
          ? settings.uploads_path
          : undefined,
    };
  }

  /**
   * The importer's SSRF-safe fetcher, locked to the source host (+ aliases
   * and uploads path of the store's ImportSource). Overridden in specs.
   */
  async fetcherFor(
    storeId: string,
    siteHost: string,
  ): Promise<NppMediaFetcher> {
    const p = await this.sourcePolicy(storeId, siteHost);
    return new SafeFetcher({
      siteHost: siteHost.toLowerCase(),
      aliases: p.aliases,
      uploadsPath: p.uploadsPath,
    });
  }

  /** Imports NPP input (shapes A–E, M4.2 §10.1) into the store. */
  async importNpp(
    storeId: string,
    payload: unknown,
    opts: NppImportOptions,
  ): Promise<NppImportReport> {
    const siteHost = opts.siteHost.toLowerCase();
    const conv = convertNpp(payload, {
      siteHost,
      normalizeLabels: opts.normalizeLabels,
      includeUnlinked: opts.includeUnlinked,
      skipProductIds: opts.skipProductIds,
      locale: opts.locale,
    });
    const { aliases } = await this.sourcePolicy(storeId, siteHost);
    const media = new Map<string, NppImportMedia>();
    for (const [k, v] of opts.media ?? [])
      media.set(mediaKey(k, siteHost, aliases), v);
    let fetcher: Promise<NppMediaFetcher> | null = null;
    const ctx: RunCtx = {
      storeId,
      opts: { ...opts, siteHost },
      aliases,
      media,
      fetcher: () =>
        (fetcher ??= opts.fetcher
          ? Promise.resolve(opts.fetcher)
          : this.fetcherFor(storeId, siteHost)),
      fetched: new Map(),
    };

    const report: NppImportReport = {
      templates: [],
      links: [],
      missing_fonts: [],
      warnings: conv.warnings.map((w) => ({
        ...w,
        code: w.code as NppImportWarningCode,
      })),
    };
    const missingFonts = new Map<string, NppFontFileHint>();
    for (const t of conv.templates) {
      if (!t.include) {
        report.templates.push({
          source_id: t.source_id,
          external_ref: t.external_ref,
          name: t.name,
          template_id: null,
          action: 'SKIP',
          version: null,
          pending_assets: [],
          warnings: this.converterWarnings(t),
        });
        continue;
      }
      try {
        const r = await this.importTemplate(ctx, t);
        for (const f of r.missingFonts)
          missingFonts.set(`${f.family}|${f.weight}|${f.style}`, f);
        report.templates.push(r.report);
      } catch (e) {
        this.logger.warn(
          `NPP template ${t.external_ref} failed: ${(e as Error).message}`,
        );
        report.templates.push({
          source_id: t.source_id,
          external_ref: t.external_ref,
          name: t.name,
          template_id: null,
          action: 'ERROR',
          version: null,
          pending_assets: [],
          warnings: this.converterWarnings(t),
          error: (e as Error).message.slice(0, 500),
        });
      }
    }
    report.missing_fonts = [...missingFonts.values()].sort(
      (a, b) =>
        a.family.localeCompare(b.family) ||
        a.weight - b.weight ||
        a.style.localeCompare(b.style),
    );

    if (opts.linkProducts !== false)
      await this.linkFromConversion(storeId, conv.product_links, report, opts);
    return report;
  }

  private converterWarnings(t: NppConvertedTemplate): NppImportWarning[] {
    return t.warnings
      .filter((w) => w.code !== 'ASSET_MISSING')
      .map((w) => ({ ...w, code: w.code as NppImportWarningCode }));
  }

  /* ---------------------------------------------------------------- */
  /* One template                                                      */
  /* ---------------------------------------------------------------- */

  private async importTemplate(
    ctx: RunCtx,
    t: NppConvertedTemplate,
  ): Promise<{
    report: NppImportTemplateReport;
    missingFonts: NppFontFileHint[];
  }> {
    const { storeId } = ctx;
    const warnings = this.converterWarnings(t);
    const warn = (w: Omit<NppImportWarning, 'template_id'>) =>
      warnings.push({ ...w, template_id: t.source_id });

    const existing = await this.prisma.designTemplate.findFirst({
      where: { store_id: storeId, source: 'npp', external_ref: t.external_ref },
    });
    const latest = existing
      ? await this.prisma.designTemplateVersion.findFirst({
          where: { template_id: existing.id },
          orderBy: { version: 'desc' },
        })
      : null;

    // 1. Bytes per fetch key, then their real (EXIF-oriented) dimensions.
    const bytes = new Map<string, Bytes & { ok: true }>();
    const probe: Record<string, NppMediaInfo | undefined> = {};
    const skipped: string[] = [];
    for (const f of t.fetch) {
      const b = await this.bytesFor(ctx, f);
      if (!b.ok) {
        if (b.reason === 'skipped') skipped.push(f.key);
        else
          warn({
            code: 'ASSET_FETCH_FAILED',
            element_id: f.element_id,
            message: `${f.url}: ${b.message}`,
            data: { key: f.key, role: f.role, url: f.url },
          });
        continue;
      }
      const dims = await this.probe(b.buf);
      if (!dims) {
        warn({
          code: 'ASSET_INVALID',
          element_id: f.element_id,
          message: `${b.url} is not a readable image.`,
          data: { key: f.key, role: f.role, url: b.url },
        });
        continue;
      }
      bytes.set(f.key, b);
      if (f.role !== 'thumb')
        probe[f.key] = {
          asset_id: PROBE + f.key,
          ...dims,
          used_fallback: b.used_fallback,
        };
    }
    if (skipped.length)
      warn({
        code: 'MEDIA_SKIPPED',
        message:
          'The media scope is off: the template was created without its images.',
        data: { keys: skipped },
      });

    // 2. Fonts: the store's uploaded faces.
    const needs: FontFace[] = t.fonts.map((f) => ({
      family: f.family,
      weight: f.weight,
      style: f.style,
    }));
    const faces = await this.fonts.resolveFaces(storeId, needs);
    const foundFaces = [...faces.found.values()];
    for (const f of t.fonts) {
      const hit = foundFaces.find(
        (x) =>
          x.family.toLowerCase() === f.family.toLowerCase() &&
          x.weight === f.weight &&
          x.style === f.style,
      );
      if (hit) probe[f.key] = { asset_id: hit.asset_id, width: 0, height: 0 };
    }
    const missingFonts: NppFontFileHint[] = faces.missing.map((f) => ({
      family: f.family,
      weight: f.weight,
      style: f.style,
      file: googleFontFileName(f),
    }));
    if (missingFonts.length)
      warn({
        code: 'FONTS_MISSING',
        message: `Upload these font files in Designer → Fonts: ${missingFonts
          .map((f) => f.file)
          .join(', ')}.`,
        data: {
          faces: missingFonts.map((f) => `${f.family} ${f.weight} ${f.style}`),
          files: missingFonts.map((f) => f.file),
        },
      });

    // 3. Post-fetch rules (swap, low-res, -scaled fallback) on the probed sizes.
    const fin = finalizeTemplateAssets(t, probe);
    for (const w of fin.warnings)
      if (w.code !== 'ASSET_MISSING')
        warn({ ...w, code: w.code as NppImportWarningCode });
    const spec = fin.spec;
    const bg = spec.surfaces[0].background;
    const orig = t.spec.surfaces[0].background;
    const prevSpec = (latest?.spec ?? null) as TemplateSpecV1 | null;
    const prevBg = prevSpec?.surfaces?.[0]?.background;

    // 4. Store each file with the kind of its final role.
    const store = async (
      ref: AssetRef,
      kind: DesignAssetKind,
      pendingKey: string,
      carry: AssetRef | undefined,
    ): Promise<AssetRef> => {
      const fallback = (): AssetRef => {
        if (carry && !carry.asset_id.startsWith(PENDING)) {
          warn({
            code: 'ASSET_REUSED',
            message: `${pendingKey} keeps the asset of the previous version.`,
            data: { key: pendingKey, asset_id: carry.asset_id },
          });
          return { ...carry };
        }
        return { asset_id: pendingKey, width: 0, height: 0 };
      };
      if (!ref.asset_id.startsWith(PROBE)) return fallback();
      const key = ref.asset_id.slice(PROBE.length);
      const b = bytes.get(key);
      if (!b) return fallback();
      try {
        const res = await this.assets.storeTemplateAsset(storeId, {
          buffer: b.buf,
          kind,
          template_id: existing?.id ?? null,
          source_url: b.url,
        });
        for (const w of res.warnings)
          if (w.code !== 'PRINT_BG_LOW_RES')
            warn({
              code: w.code,
              message: `${kind}: ${w.code}`,
              data: { key: pendingKey, ...(w.params ?? {}) },
            });
        return {
          asset_id: res.asset.id,
          width: res.asset.width,
          height: res.asset.height,
        };
      } catch (e) {
        warn({
          code: 'ASSET_INVALID',
          message: `${b.url}: ${(e as Error).message}`,
          data: { key: pendingKey, url: b.url },
        });
        return fallback();
      }
    };
    if (orig.web)
      bg.web = await store(
        bg.web ?? { asset_id: orig.web.asset_id, width: 0, height: 0 },
        DesignAssetKind.TEMPLATE_BG_WEB,
        orig.web.asset_id,
        prevBg?.web,
      );
    if (orig.print)
      bg.print = await store(
        bg.print ?? { asset_id: orig.print.asset_id, width: 0, height: 0 },
        DesignAssetKind.TEMPLATE_BG_PRINT,
        orig.print.asset_id,
        prevBg?.print,
      );
    for (const el of spec.surfaces[0].elements) {
      if (el.type !== 'image') continue;
      const prevEl = prevSpec?.surfaces?.[0]?.elements?.find(
        (p) => p.id === el.id && p.type === 'image',
      );
      const pendingKey = el.asset.asset_id.startsWith(PROBE)
        ? el.asset.asset_id.slice(PROBE.length)
        : el.asset.asset_id;
      el.asset = await store(
        el.asset,
        DesignAssetKind.TEMPLATE_DECO,
        pendingKey,
        prevEl && prevEl.type === 'image' ? prevEl.asset : undefined,
      );
    }
    let thumbnailUrl: string | null = null;
    const thumb = bytes.get('pending:thumb');
    if (thumb) {
      try {
        const res = await this.assets.storeTemplateAsset(storeId, {
          buffer: thumb.buf,
          kind: DesignAssetKind.TEMPLATE_THUMB,
          source_url: thumb.url,
        });
        thumbnailUrl = res.asset.url;
      } catch (e) {
        warn({
          code: 'ASSET_INVALID',
          message: `${thumb.url}: ${(e as Error).message}`,
          data: { key: 'pending:thumb', url: thumb.url },
        });
      }
    }
    if (!thumbnailUrl) thumbnailUrl = latest?.thumbnail_url ?? null;

    const pending = this.pendingOf(spec);

    // 5. Template + immutable version (idempotent by spec sha256). A
    // re-import never overrides the merchant: an existing template keeps
    // its name (NAME_KEPT when the source name differs), and when the
    // latest version is a merchant edit (`created_by` set) no version is
    // appended over it (MERCHANT_EDITED when the source changed since the
    // last imported version).
    const sha = specSha256(spec);
    const sourceName = (t.name || `NPP ${t.source_id}`).slice(0, 160);
    const name = existing ? existing.name : sourceName;
    if (existing && existing.name !== sourceName) {
      warn({
        code: 'NAME_KEPT',
        message: `The template keeps its name "${existing.name}" (source: "${sourceName}").`,
        data: { name: existing.name, source_name: sourceName },
      });
    }
    const merchantEdited = !!(existing && latest && latest.created_by);
    const lastImported =
      merchantEdited && existing
        ? await this.prisma.designTemplateVersion.findFirst({
            where: { template_id: existing.id, created_by: null },
            orderBy: { version: 'desc' },
            select: { spec_sha256: true },
          })
        : null;
    let action: NppTemplateAction;
    let templateId: string;
    let version: number;
    if (existing && latest && latest.spec_sha256 === sha) {
      action = 'UNCHANGED';
      templateId = existing.id;
      version = latest.version;
    } else if (existing && latest && merchantEdited) {
      action = 'UNCHANGED';
      templateId = existing.id;
      version = latest.version;
      if (lastImported?.spec_sha256 !== sha) {
        warn({
          code: 'MERCHANT_EDITED',
          message: `The source template changed, but version ${latest.version} was edited in the designer; the import did not add a version over it.`,
          data: { version: latest.version },
        });
      }
    } else {
      const saved = await this.saveVersion(storeId, t, existing, latest, {
        name,
        spec,
        sha,
        thumbnailUrl,
        createdBy: ctx.opts.createdBy ?? null,
      });
      action = existing ? 'UPDATE' : 'CREATE';
      templateId = saved.templateId;
      version = saved.version;
    }
    return {
      report: {
        source_id: t.source_id,
        external_ref: t.external_ref,
        name,
        template_id: templateId,
        action,
        version,
        pending_assets: pending,
        warnings,
      },
      missingFonts,
    };
  }

  private pendingOf(spec: TemplateSpecV1): string[] {
    const out: string[] = [];
    const bg = spec.surfaces[0].background;
    for (const r of [bg.web, bg.print])
      if (r?.asset_id.startsWith(PENDING)) out.push(r.asset_id);
    for (const el of spec.surfaces[0].elements)
      if (el.type === 'image' && el.asset.asset_id.startsWith(PENDING))
        out.push(el.asset.asset_id);
    for (const f of spec.fonts)
      if (f.asset_id.startsWith(PENDING)) out.push(f.asset_id);
    return out;
  }

  private async saveVersion(
    storeId: string,
    t: NppConvertedTemplate,
    existing: DesignTemplate | null,
    latest: DesignTemplateVersion | null,
    v: {
      name: string;
      spec: TemplateSpecV1;
      sha: string;
      thumbnailUrl: string | null;
      createdBy: string | null;
    },
  ): Promise<{ templateId: string; version: number }> {
    const specJson = v.spec as unknown as Prisma.InputJsonValue;
    return this.prisma.$transaction(async (tx: Tx) => {
      let templateId: string;
      if (existing) {
        templateId = existing.id;
        if (existing.name !== v.name)
          await tx.designTemplate.update({
            where: { id: existing.id },
            data: { name: v.name },
          });
      } else {
        const created = await tx.designTemplate.create({
          data: {
            store_id: storeId,
            name: v.name,
            status: 'DRAFT',
            source: 'npp',
            external_ref: t.external_ref,
          },
        });
        templateId = created.id;
      }
      const version = (latest?.version ?? 0) + 1;
      await tx.designTemplateVersion.create({
        data: {
          template_id: templateId,
          version,
          spec: specJson,
          spec_sha256: v.sha,
          thumbnail_url: v.thumbnailUrl,
          created_by: v.createdBy,
        },
      });
      return { templateId, version };
    });
  }

  /* ---------------------------------------------------------------- */
  /* Bytes                                                             */
  /* ---------------------------------------------------------------- */

  /** Importer copy first (no network), else the safe fetcher if allowed. */
  private async bytesFor(ctx: RunCtx, f: NppFetch): Promise<Bytes> {
    const { siteHost } = ctx.opts;
    const candidates: [string, boolean][] = [[f.url, false]];
    if (f.fallback_url) candidates.push([f.fallback_url, true]);
    for (const [url, isFallback] of candidates) {
      const m = ctx.media.get(mediaKey(url, siteHost, ctx.aliases));
      if (!m?.private_key) continue;
      const buf = await this.storage.read(m.private_key).catch(() => null);
      if (!buf?.length) continue;
      // The importer tried the original first (D9); only its fetched_url
      // tells whether the -scaled file had to be used.
      const usedScaled =
        !!f.fallback_url &&
        (m.fetched_url
          ? mediaKey(m.fetched_url, siteHost, ctx.aliases) ===
            mediaKey(f.fallback_url, siteHost, ctx.aliases)
          : false);
      return {
        ok: true,
        buf,
        url: isFallback ? f.fallback_url! : f.url,
        used_fallback: usedScaled,
      };
    }
    if (!ctx.opts.fetchMedia)
      return { ok: false, reason: 'skipped', message: 'media scope off' };
    const fetchKey = `${f.url}|${f.fallback_url ?? ''}`;
    let p = ctx.fetched.get(fetchKey);
    if (!p) {
      p = this.fetchBytes(ctx, f);
      ctx.fetched.set(fetchKey, p);
    }
    return p;
  }

  private async fetchBytes(ctx: RunCtx, f: NppFetch): Promise<Bytes> {
    const fetcher = await ctx.fetcher();
    let last = 'no candidate';
    const list = [f.url, ...(f.fallback_url ? [f.fallback_url] : [])];
    for (const url of list) {
      try {
        const res = await fetcher.get(url, {
          maxBytes: TEMPLATE_ASSET_MAX_BYTES,
          accept: 'image/*',
          purpose: 'media',
        });
        if (res.status !== 200) {
          last = `HTTP ${res.status}`;
          continue;
        }
        if (!sniffImage(res.body)) {
          last = 'not an image';
          continue;
        }
        return {
          ok: true,
          buf: res.body,
          url,
          used_fallback: url === f.fallback_url,
        };
      } catch (e) {
        last = (e as Error).message;
      }
    }
    return { ok: false, reason: 'failed', message: last };
  }

  /** Displayed size (EXIF orientation applied), or null when undecodable. */
  private async probe(
    buf: Buffer,
  ): Promise<{ width: number; height: number } | null> {
    try {
      const m = await sharp(buf, {
        limitInputPixels: TEMPLATE_RASTER_LIMITS.maxPixels,
      }).metadata();
      if (!m.width || !m.height) return null;
      const rotated = (m.orientation ?? 1) >= 5;
      return rotated
        ? { width: m.height, height: m.width }
        : { width: m.width, height: m.height };
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Product links                                                     */
  /* ---------------------------------------------------------------- */

  private async linkFromConversion(
    storeId: string,
    links: NppProductLink[],
    report: NppImportReport,
    opts: NppImportOptions,
  ): Promise<void> {
    const skip = new Set(opts.skipProductIds ?? []);
    const store = await this.prisma.store.findUnique({
      where: { id: storeId },
      select: { creator_id: true },
    });
    const refs = links.map((l) => l.product_external_ref);
    const products = store
      ? await this.prisma.product.findMany({
          where: { creator_id: store.creator_id, external_ref: { in: refs } },
          select: { id: true, external_ref: true },
        })
      : [];
    const byRef = new Map(products.map((p) => [p.external_ref, p.id]));
    for (const l of links) {
      const tpl = report.templates.find(
        (t) => t.external_ref === l.template_external_ref,
      );
      const row: NppImportLinkReport = {
        product_source_id: l.product_source_id,
        product_external_ref: l.product_external_ref,
        product_id: byRef.get(l.product_external_ref) ?? null,
        template_external_ref: l.template_external_ref,
        template_id: tpl?.template_id ?? null,
        action: 'SKIP',
      };
      report.links.push(row);
      if (skip.has(l.product_source_id)) {
        // (A) inputs were already reported by the converter.
        if (
          !report.warnings.some(
            (w) =>
              w.code === 'PRODUCT_SKIPPED' &&
              w.data?.product_id === l.product_source_id,
          )
        )
          report.warnings.push({
            code: 'PRODUCT_SKIPPED',
            template_id: l.template_source_id,
            message: `Product ${l.product_source_id} is skipped by configuration.`,
            data: { product_id: l.product_source_id },
          });
        continue;
      }
      if (!row.template_id) continue;
      if (!row.product_id) {
        report.warnings.push({
          code: 'PRODUCT_NOT_FOUND',
          template_id: l.template_source_id,
          message: `No imported product ${l.product_external_ref}; the link is skipped.`,
          data: { product_external_ref: l.product_external_ref },
        });
        continue;
      }
      const productId = row.product_id;
      const templateId = row.template_id;
      row.action = await this.prisma.$transaction((tx: Tx) =>
        this.link(tx, storeId, productId, templateId, {
          addons: l.addons,
          pricing: l.pricing,
        }),
      );
      if (row.action === 'SKIP')
        report.warnings.push({
          code: 'PRODUCT_LINK_KEPT',
          template_id: l.template_source_id,
          message: `Product ${l.product_external_ref} already uses another enabled template; its link is kept.`,
          data: { product_external_ref: l.product_external_ref },
        });
    }
  }

  /**
   * `ProductDesigner{enabled:false}` for an imported product. An existing
   * link is updated (template, add-ons) unless the merchant already enabled
   * the designer with a different template (`SKIP`, kept as is).
   */
  async link(
    db: Tx,
    storeId: string,
    productId: string,
    templateId: string,
    src: { addons?: unknown; pricing?: unknown },
  ): Promise<NppLinkAction> {
    const imported = normalizeNppAddons(src.addons, src.pricing);
    const cur = await db.productDesigner.findUnique({
      where: { product_id: productId },
    });
    // M5.5: a link whose add-ons the merchant configured (v2) keeps its
    // items; the re-imported NPP data only refreshes the kept presets.
    const addons =
      cur && isAddonsV2(cur.addons)
        ? (() => {
            const { imported: _old, ...rest } = cur.addons as Record<
              string,
              unknown
            >;
            return Object.keys(imported).length ? { ...rest, imported } : rest;
          })()
        : imported;
    if (!cur) {
      await db.productDesigner.create({
        data: {
          product_id: productId,
          store_id: storeId,
          template_id: templateId,
          enabled: false,
          addons: addons as Prisma.InputJsonValue,
        },
      });
      return 'CREATE';
    }
    if (cur.template_id !== templateId && cur.enabled) return 'SKIP';
    if (
      cur.template_id === templateId &&
      stableJson(cur.addons) === stableJson(addons)
    )
      return 'UNCHANGED';
    await db.productDesigner.update({
      where: { product_id: productId },
      data: {
        template_id: templateId,
        addons: addons as Prisma.InputJsonValue,
      },
    });
    return 'UPDATE';
  }
}
