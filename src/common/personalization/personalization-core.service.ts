import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { CustomFieldType, Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CustomerUploadsService } from '../../modules/customer-uploads/customer-uploads.service';
import { parseCustomerPreviewId } from '../../modules/customer-uploads/customer-uploads.types';
import type { ResolvedCustomerUpload } from '../../modules/customer-uploads/customer-uploads.types';
import { pickTranslation } from './pick-translation';
import { createServerPatternTester } from './pattern-tester';
import {
  isFileRefPath,
  fileRefPath,
  validatePersonalization,
  type FieldDef,
  type Issue,
  type NormalizedValue,
  type NormalizedValues,
} from './rules';
import { lineSnapshotColumns } from './evaluator';
import { APP_ONLY_TYPES, type PLine } from './types';

/**
 * Platform-wide personalization checks (M4.0 §4, contracts C13/C19/C29).
 *
 * One place validates custom field values on every write (cart add/update,
 * quote, order create) and one place writes the order snapshot rows
 * (`buildOrderValues`). Products without custom fields see no difference:
 * no fields → no issues, no values, no rows.
 */

/** A field definition as loaded with its translations. */
export interface CoreFieldDef extends FieldDef {
  type: CustomFieldType;
  sort_order: number;
  translations: {
    locale: string;
    label: string;
    option_labels?: Prisma.JsonValue | null;
  }[];
}

/** Per-line context: the product's fields and the creator-filled values. */
export interface LineContext {
  productId: string | null;
  /**
   * The fields the M4.0 rules check: top-level fields of M4.0 types (the
   * legacy branch of the M4.1 evaluator, D10). Equal to every field for a
   * product without M4.1 config.
   */
  fields: CoreFieldDef[];
  /**
   * Every field row of the product (M4.1 children and app-only types too),
   * for the personalization app's evaluator. Absent = same as `fields`.
   */
  allFields?: CoreFieldDef[];
  /** Creator-filled values of a custom product, keyed by field id. */
  prefilled: Record<string, string>;
}

/** The M4.0-visible fields of a product (top level, M4.0 types; D10). */
export function legacyFields<
  T extends { type: string; parent_id?: string | null },
>(fields: readonly T[]): T[] {
  return fields.filter((f) => !f.parent_id && !APP_ONLY_TYPES.has(f.type));
}

/** The ids a line carries (cart DTO, cart row or snapshot line). */
export interface PersonalizationLineRef {
  product_id?: string | null;
  custom_product_id?: string | null;
  /** M4.1: a variant-only line resolves its product from the variant. */
  variant_id?: string | null;
}

export const PRODUCT_VARIANT_MISMATCH = 'PRODUCT_VARIANT_MISMATCH';

/** Where an error points: a cart row (`line_id`) or a snapshot position. */
export interface LineErrorRef {
  line_id?: string;
  line_index?: number;
}

/** A legacy `item_customizations[id].custom_field_values` entry. */
export interface LegacyFieldValueInput {
  custom_field_id: string;
  value?: string | null;
  file_url?: string | null;
}

export type OrderValueRow =
  Prisma.OrderCustomFieldValueUncheckedCreateWithoutOrder_itemInput;

export const CUSTOMER_UPLOAD_EXPIRED = 'CUSTOMER_UPLOAD_EXPIRED';

/** English fallback messages; clients translate `errors.<code>` with `params`. */
const ISSUE_MESSAGES: Record<Issue['code'], (label: string) => string> = {
  // Kept verbatim from the pre-M4.0 order check for clients that parse it.
  CUSTOM_FIELD_REQUIRED: (l) => `Required field "${l}" is missing`,
  CUSTOM_FIELD_TOO_SHORT: (l) => `"${l}" is too short`,
  CUSTOM_FIELD_TOO_LONG: (l) => `"${l}" is too long`,
  CUSTOM_FIELD_INVALID_NUMBER: (l) => `"${l}" must be a number`,
  CUSTOM_FIELD_NUMBER_TOO_SMALL: (l) => `"${l}" is too small`,
  CUSTOM_FIELD_NUMBER_TOO_LARGE: (l) => `"${l}" is too large`,
  CUSTOM_FIELD_INVALID_FORMAT: (l) => `"${l}" has an invalid format`,
  CUSTOM_FIELD_INVALID_CHARS: (l) =>
    `"${l}" contains characters that are not allowed`,
  CUSTOM_FIELD_LENGTH_MISMATCH: (l) =>
    `"${l}" must have the same length as its linked field`,
  CUSTOM_FIELD_COMBINED_TOO_LONG: (l) =>
    `"${l}" and its linked field are too long together`,
  CUSTOM_FIELD_INVALID_OPTION: (l) => `"${l}" has an invalid option`,
  CUSTOM_FIELD_INVALID_COLOR: (l) => `"${l}" must be a colour like #ff0000`,
  CUSTOM_FIELD_INVALID_DATE: (l) => `"${l}" must be a valid date`,
  CUSTOM_FIELD_INVALID_FILE: (l) => `"${l}" has an invalid file`,
  CUSTOM_FIELD_TOO_MANY_FILES: (l) => `"${l}" has too many files`,
  CUSTOM_FIELD_INVALID_PAYLOAD: () => 'Invalid personalization values',
};

const FILE_TYPES = new Set<string>(['IMAGE', 'FILE', 'MULTI_IMAGE']);
const OPTION_TYPES = new Set<string>(['SELECT', 'FONT']);

/** Origins (scheme://host[:port]) customer file URLs may point at. */
function allowedFileOrigins(): Set<string> {
  const out = new Set<string>();
  const add = (raw: string | undefined) => {
    if (!raw) return;
    try {
      out.add(new URL(raw.trim()).origin.toLowerCase());
    } catch {
      // Ignore malformed entries.
    }
  };
  add(process.env.PUBLIC_API_URL);
  for (const part of (process.env.API_PUBLIC_ORIGINS ?? '').split(',')) {
    add(part);
  }
  return out;
}

@Injectable()
export class PersonalizationCoreService {
  private readonly logger = new Logger(PersonalizationCoreService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly customerUploads: CustomerUploadsService,
  ) {}

  /**
   * Field definitions and creator-filled values for every line, in two
   * batched queries at most (Kustom validation budget, W14). The result is
   * index-aligned with `lines`.
   */
  async loadContexts(
    lines: readonly PersonalizationLineRef[],
  ): Promise<LineContext[]> {
    const customIds = [
      ...new Set(
        lines.map((l) => l.custom_product_id).filter((v): v is string => !!v),
      ),
    ];
    const customProducts = customIds.length
      ? await this.prisma.customProduct.findMany({
          where: { id: { in: customIds } },
          select: {
            id: true,
            product_id: true,
            field_values: {
              select: { custom_field_id: true, value: true, file_url: true },
            },
          },
        })
      : [];
    const byCustom = new Map(customProducts.map((cp) => [cp.id, cp]));

    // M4.1: a variant-only line (no product_id) resolves its product
    // through the variant, in one batched query, so it still gets its
    // fields and personalization. Lines that carry a product_id make no
    // variant query here (M5 A11): the cart write and the order loop
    // check that the variant belongs to the product themselves.
    const variantIds = [
      ...new Set(
        lines
          .filter((l) => !l.custom_product_id && !l.product_id && l.variant_id)
          .map((l) => l.variant_id as string),
      ),
    ];
    const variants = variantIds.length
      ? await this.prisma.productVariant.findMany({
          where: { id: { in: variantIds } },
          select: { id: true, product_id: true },
        })
      : [];
    const productOfVariant = new Map(variants.map((v) => [v.id, v.product_id]));

    const productIdOf = (l: PersonalizationLineRef): string | null =>
      l.custom_product_id
        ? (byCustom.get(l.custom_product_id)?.product_id ?? null)
        : (l.product_id ??
          (l.variant_id ? productOfVariant.get(l.variant_id) : undefined) ??
          null);

    const productIds = [
      ...new Set(lines.map(productIdOf).filter((v): v is string => !!v)),
    ];
    const fields = productIds.length
      ? await this.prisma.productCustomField.findMany({
          where: { product_id: { in: productIds } },
          include: { translations: true },
          // id breaks sort_order ties so every reader sees the same order.
          orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
        })
      : [];
    const byProduct = new Map<string, CoreFieldDef[]>();
    for (const f of fields) {
      const list = byProduct.get(f.product_id) ?? [];
      list.push(f as unknown as CoreFieldDef);
      byProduct.set(f.product_id, list);
    }

    return lines.map((l) => {
      const productId = productIdOf(l);
      const prefilled: Record<string, string> = {};
      const cp = l.custom_product_id
        ? byCustom.get(l.custom_product_id)
        : undefined;
      for (const v of cp?.field_values ?? []) {
        const val = v.value || v.file_url;
        if (val) prefilled[v.custom_field_id] = val;
      }
      const all = productId ? (byProduct.get(productId) ?? []) : [];
      const fields = legacyFields(all);
      return {
        productId,
        fields,
        // Only set when M4.1 rows exist, so an M4.0 context is unchanged.
        ...(fields.length !== all.length ? { allFields: all } : {}),
        prefilled,
      };
    });
  }

  /**
   * Customer file check: the path must be a customer-file folder, and an
   * absolute URL must point at one of the API's public origins
   * (PUBLIC_API_URL, API_PUBLIC_ORIGINS). Without any configured origin only
   * the path is checked in development; in production (NODE_ENV=production)
   * absolute URLs are then refused (fail closed) and relative ones still pass.
   */
  isFileRef = (url: string): boolean => {
    if (!isFileRefPath(url)) return false;
    if (url.startsWith('/')) return true;
    const origins = allowedFileOrigins();
    if (origins.size === 0) return process.env.NODE_ENV !== 'production';
    try {
      return origins.has(new URL(url).origin.toLowerCase());
    } catch {
      return false;
    }
  };

  /** Converts legacy `custom_field_values` entries into a values object. */
  valuesFromLegacyDto(
    entries: readonly LegacyFieldValueInput[],
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const e of entries) {
      if (!e || typeof e.custom_field_id !== 'string') continue;
      // `||`: an empty `value` next to a `file_url` must not hide the file.
      const v = e.value || e.file_url || null;
      if (v === null || v === '') continue;
      const prev = out[e.custom_field_id];
      // Repeated ids (MULTI_IMAGE files) collect into an array.
      if (prev === undefined) out[e.custom_field_id] = v;
      else if (Array.isArray(prev)) prev.push(v);
      else out[e.custom_field_id] = [prev, v];
    }
    return out;
  }

  /**
   * Validates one line and returns its normalized values (known, visible
   * fields only, creator-filled values injected). Throws a 400 with the first
   * issue: `{ code, message, params: {...issue.params, label}, field_id,
   * field_name, line_id? | line_index? }`.
   */
  assertLine(
    values: unknown,
    ctx: LineContext,
    locale?: string | null,
    ref: LineErrorRef = {},
  ): NormalizedValues {
    if (ctx.fields.length === 0) return {};
    const res = validatePersonalization({
      fields: ctx.fields,
      values,
      prefilled: ctx.prefilled,
      isFileRef: this.isFileRef,
      // ReDoS guard: merchant patterns run under a hard timeout (fail closed).
      patternTester: createServerPatternTester(),
    });
    if (res.ok) return res.values;
    const issue = res.issues[0];
    const field = ctx.fields.find((f) => f.id === issue.field_id);
    const label = field ? this.fieldLabel(field, locale) : '';
    throw new BadRequestException({
      code: issue.code,
      message: ISSUE_MESSAGES[issue.code](label),
      params: { ...(issue.params ?? {}), label },
      field_id: issue.field_id,
      field_name: issue.field_name,
      ...(ref.line_id !== undefined ? { line_id: ref.line_id } : {}),
      ...(ref.line_index !== undefined ? { line_index: ref.line_index } : {}),
    });
  }

  /** Label of a field in `locale` (then en, then first, then the name). */
  fieldLabel(
    field: Pick<CoreFieldDef, 'name' | 'translations'>,
    locale?: string | null,
  ): string {
    return pickTranslation(field.translations, locale)?.label || field.name;
  }

  /** File values of a line that are customer-upload previews. */
  private previewUrls(ctx: LineContext, values: NormalizedValues): string[] {
    const urls: string[] = [];
    for (const f of ctx.fields) {
      if (!FILE_TYPES.has(f.type)) continue;
      for (const v of asList(values[f.id])) {
        if (typeof v === 'string' && parseCustomerPreviewId(v)) urls.push(v);
      }
    }
    return urls;
  }

  /**
   * Resolves every customer-upload preview URL of an order in one query.
   * Returns an empty map (and makes no call) when the order has none.
   * Uploads already attached to another store are left out (they read as
   * missing → `CUSTOMER_UPLOAD_EXPIRED`), so a preview URL seen on someone
   * else's order can never be linked to this one.
   */
  async resolveUploads(
    lines: readonly { ctx: LineContext; values: NormalizedValues }[],
    storeId: string,
  ): Promise<Map<string, ResolvedCustomerUpload>> {
    const urls = [
      ...new Set(lines.flatMap((l) => this.previewUrls(l.ctx, l.values))),
    ];
    if (urls.length === 0) return new Map();
    return this.customerUploads.resolveForOrder(urls, storeId);
  }

  /**
   * Quote path (Kustom validation, storefront totals): the same upload check
   * as the order write, without building rows. Throws
   * `CUSTOMER_UPLOAD_EXPIRED` for a missing, purged or foreign upload. No
   * query when no line carries a preview URL.
   */
  async assertUploadsAvailable(
    lines: readonly {
      ctx: LineContext;
      values: NormalizedValues;
      ref: LineErrorRef;
    }[],
    storeId: string,
    locale?: string | null,
  ): Promise<void> {
    const uploads = await this.resolveUploads(lines, storeId);
    // buildOrderValues throws on the first unavailable upload; lines without
    // preview URLs never throw here.
    for (const l of lines) {
      this.buildOrderValues(l.ref, l.ctx, l.values, { uploads, locale });
    }
  }

  /**
   * THE snapshot writer (K8, C19): the `custom_field_values.create` rows of
   * one order line, created nested inside `order.create`. Rows follow the
   * field order; the type decides `value` vs `file_url` (bug 5); MULTI_IMAGE
   * gets one row per file (W3); every row carries the frozen field snapshot.
   * A customer preview URL whose upload is missing or purged throws
   * `CUSTOMER_UPLOAD_EXPIRED`.
   */
  buildOrderValues(
    line: LineErrorRef,
    ctx: LineContext,
    values: NormalizedValues,
    opts: {
      uploads?: Map<string, ResolvedCustomerUpload>;
      locale?: string | null;
      /**
       * M4.1 (C19): the personalization app's evaluator lines. When given,
       * one row per line with the group / source / price / meta columns
       * (`price_delta` already in the order currency); `values` is then
       * not read (the caller resolved the uploads from it).
       */
      lines?: readonly PLine[];
      /**
       * M4.2 designer (C19): the design's text values. One row each after
       * the field rows: `custom_field_id` null, `source 'DESIGN'`,
       * `field_type TEXT`, `field_name` = element id, `field_label` = the
       * template label map, `sort_order` 10000+i. Absent = no extra rows.
       */
      designTexts?: readonly DesignTextRowInput[];
    } = {},
  ): OrderValueRow[] {
    const rows: OrderValueRow[] = [];
    const uploads = opts.uploads ?? new Map<string, ResolvedCustomerUpload>();
    if (opts.lines) {
      return [
        ...this.rowsFromLines(line, ctx, opts.lines, uploads, opts.locale),
        ...designTextRows(opts.designTexts),
      ];
    }
    for (const f of ctx.fields) {
      const v = values[f.id];
      if (v === undefined) continue;
      const snapshot = this.fieldSnapshot(f);
      if (FILE_TYPES.has(f.type)) {
        for (const item of asList(v)) {
          if (typeof item !== 'string' || item === '') continue;
          const uploadId = this.uploadIdFor(
            item,
            f,
            uploads,
            line,
            opts.locale,
          );
          rows.push({
            custom_field_id: f.id,
            file_url: item,
            ...(uploadId ? { upload_id: uploadId } : {}),
            ...snapshot,
          });
        }
        continue;
      }
      const text = valueText(v);
      if (text === null) continue;
      const display = OPTION_TYPES.has(f.type)
        ? optionDisplay(f, text)
        : undefined;
      rows.push({
        custom_field_id: f.id,
        value: text,
        ...snapshot,
        ...(display ? { display_value: display } : {}),
      });
    }
    rows.push(...designTextRows(opts.designTexts));
    return rows;
  }

  /**
   * Snapshot rows of the personalization app (M4.1 D11, C1/C19): one row
   * per evaluator line (`lineSnapshotColumns`), so repeater items carry
   * `group_key / group_index / group_label`, variant option lines
   * `source='OPTION'` and `meta`, and every row its per-unit `price_delta`.
   * File lines keep the M4.0 upload attach (same expiry error).
   */
  private rowsFromLines(
    ref: LineErrorRef,
    ctx: LineContext,
    lines: readonly PLine[],
    uploads: Map<string, ResolvedCustomerUpload>,
    locale?: string | null,
  ): OrderValueRow[] {
    const all = ctx.allFields ?? ctx.fields;
    return lines.map((l) => {
      const cols = lineSnapshotColumns(l);
      const row = {
        ...cols,
        field_type: cols.field_type as CustomFieldType | undefined,
      } as OrderValueRow;
      if (l.is_file && l.field_id) {
        const field = all.find((f) => f.id === l.field_id);
        const uploadId = field
          ? this.uploadIdFor(l.value, field, uploads, ref, locale)
          : null;
        if (uploadId) row.upload_id = uploadId;
      }
      return row;
    });
  }

  /**
   * Per upload id, the field and the line whose row references it, so an
   * upload that `markAttached` cannot attach (purged or claimed by another
   * store between the quote and the commit) is reported like a missing one:
   * `CUSTOMER_UPLOAD_EXPIRED` with `field_id/field_name/line_id|line_index`
   * (M5 A3). The first row wins when several reference the same upload.
   */
  uploadRefsOf(
    rows: readonly OrderValueRow[],
    ctx: LineContext,
    line: LineErrorRef,
    into: Map<string, UploadRef> = new Map(),
  ): Map<string, UploadRef> {
    const all = ctx.allFields ?? ctx.fields;
    for (const r of rows) {
      if (!r.upload_id || into.has(r.upload_id)) continue;
      const field = r.custom_field_id
        ? all.find((f) => f.id === r.custom_field_id)
        : undefined;
      into.set(r.upload_id, { field, line });
    }
    return into;
  }

  /**
   * The `CUSTOMER_UPLOAD_EXPIRED` error for one upload reference (the same
   * body `buildOrderValues` throws for a missing or purged upload).
   */
  uploadExpired(ref: UploadRef | undefined, locale?: string | null) {
    const field = ref?.field;
    const label = field ? this.fieldLabel(field, locale) : '';
    const line = ref?.line ?? {};
    return new BadRequestException({
      code: CUSTOMER_UPLOAD_EXPIRED,
      message: label
        ? `The file for "${label}" is no longer available. Please upload it again.`
        : 'A file of this order is no longer available. Please upload it again.',
      params: { label },
      field_id: field?.id ?? '',
      field_name: field?.name ?? '',
      ...(line.line_id !== undefined ? { line_id: line.line_id } : {}),
      ...(line.line_index !== undefined ? { line_index: line.line_index } : {}),
    });
  }

  /** Upload ids referenced by built rows (for `markAttached`). */
  uploadIdsOf(rows: readonly OrderValueRow[]): string[] {
    return [
      ...new Set(
        rows
          .map((r) => r.upload_id)
          .filter((v): v is string => typeof v === 'string' && v !== ''),
      ),
    ];
  }

  private fieldSnapshot(f: CoreFieldDef) {
    const labels: Record<string, string> = {};
    for (const t of f.translations ?? []) {
      if (t.label) labels[t.locale] = t.label;
    }
    return {
      field_name: f.name,
      field_type: f.type,
      sort_order: f.sort_order,
      ...(Object.keys(labels).length > 0 ? { field_label: labels } : {}),
    };
  }

  private uploadIdFor(
    url: string,
    field: CoreFieldDef,
    uploads: Map<string, ResolvedCustomerUpload>,
    line: LineErrorRef,
    locale?: string | null,
  ): string | null {
    if (!parseCustomerPreviewId(url)) return null; // legacy value, no upload row
    const up = uploads.get(url);
    if (up && !up.purged) return up.id;
    this.logger.warn(
      `Customer upload behind ${fileRefPath(url) ?? 'a value'} is ${up ? 'purged' : 'missing'} (field ${field.id})`,
    );
    throw this.uploadExpired({ field, line }, locale);
  }
}

/** The field and line behind an upload id of built order rows (M5 A3). */
export interface UploadRef {
  field: CoreFieldDef | undefined;
  line: LineErrorRef;
}

/** One text of a customer design (M4.2), written as a `DESIGN` value row. */
export interface DesignTextRowInput {
  element_id: string;
  /** Template label per locale (never the client's). */
  label: Record<string, string>;
  value: string;
}

/** First sort_order of the designer rows (after any field row). */
export const DESIGN_ROW_SORT_BASE = 10000;

function designTextRows(
  texts: readonly DesignTextRowInput[] | undefined,
): OrderValueRow[] {
  return (texts ?? []).map((t, i) => ({
    custom_field_id: null,
    value: t.value,
    field_name: t.element_id,
    field_type: CustomFieldType.TEXT,
    ...(Object.keys(t.label ?? {}).length > 0
      ? { field_label: { ...t.label } }
      : {}),
    sort_order: DESIGN_ROW_SORT_BASE + i,
    source: 'DESIGN',
  }));
}

function asList(v: NormalizedValue | undefined): NormalizedValue[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

/** Text stored in `value`: scalars as strings, anything nested as JSON. */
function valueText(v: NormalizedValue): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) {
    return v.every((x) => typeof x === 'string' || typeof x === 'number')
      ? v.map(String).join(', ')
      : JSON.stringify(v);
  }
  return JSON.stringify(v);
}

/** `{locale: option label}` of a SELECT/FONT value, or undefined when no locale translates it. */
function optionDisplay(
  f: CoreFieldDef,
  value: string,
): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const t of f.translations ?? []) {
    const labels = t.option_labels;
    if (!labels || typeof labels !== 'object' || Array.isArray(labels))
      continue;
    const l = (labels as Record<string, unknown>)[value];
    if (typeof l === 'string' && l !== '') out[t.locale] = l;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
