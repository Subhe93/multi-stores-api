import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import {
  sanitizeLinkedValidation,
  sanitizeOptions,
  sanitizeValidationRules,
} from '../custom-fields/custom-field-definition';
import {
  type ConfigSibling,
  validateFieldConfig,
  validateTranslationExtras,
} from './personalization-config.validator';
import {
  configInvalid,
  creatorProductOnly,
  FIELD_LIMITS,
  fieldLimit,
  type ConfigIssue,
} from './personalization.errors';
import type { DraftTranslation, FieldDraft } from './presets/preset.types';

/**
 * Creates field drafts (presets, library templates) inside a caller's
 * transaction with the same checks as the custom-field write path: M4.0's
 * rule sanitizers and the M4.1 config validator. Name conflicts are the
 * caller's decision (append / skip / replace).
 */

export interface FieldWriteContext {
  productId: string;
  optionConfig: unknown;
  /** The product's fields; extended with every created row. */
  siblings: ConfigSibling[];
  /** Next top-level sort_order (after the existing fields). */
  nextSortOrder: number;
}

const fieldInclude = { translations: true } as const;
type CreatedRow = Prisma.ProductCustomFieldGetPayload<{
  include: typeof fieldInclude;
}>;
export type CreatedField = CreatedRow & { children: CreatedRow[] };

/** Next top-level sort_order of a product (max + 1, 0 when empty). */
export async function nextTopSortOrder(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<number> {
  const last = await tx.productCustomField.aggregate({
    where: { product_id: productId, parent_id: null },
    _max: { sort_order: true },
  });
  const max = last?._max?.sort_order;
  return typeof max === 'number' ? max + 1 : 0;
}

/** A config column to write; null, undefined and an empty `{}` are stored as NULL. */
function json(v: unknown): Prisma.InputJsonValue | undefined {
  if (v === undefined || v === null) return undefined;
  if (
    typeof v === 'object' &&
    !Array.isArray(v) &&
    Object.keys(v).length === 0
  ) {
    return undefined;
  }
  return v as Prisma.InputJsonValue;
}

function translationRows(list: DraftTranslation[]) {
  return list.map((t) => {
    const row: Record<string, unknown> = { locale: t.locale, label: t.label };
    for (const k of [
      'placeholder',
      'display_label',
      'sublabel',
      'note',
      'help_text',
      'help_image_url',
    ] as const) {
      if (t[k] !== undefined && t[k] !== null) row[k] = t[k];
    }
    if (t.option_labels) row.option_labels = t.option_labels;
    if (t.messages && Object.keys(t.messages).length > 0)
      row.messages = t.messages;
    return row as unknown as Prisma.CustomFieldTranslationCreateWithoutFieldInput;
  });
}

function prefixed(issues: ConfigIssue[], prefix: string): ConfigIssue[] {
  return issues.map((i) => ({ ...i, path: `${prefix}.${i.path}` }));
}

async function createOne(
  tx: Prisma.TransactionClient,
  ctx: FieldWriteContext,
  draft: FieldDraft,
  parentId: string | null,
  sortOrder: number,
  meta: { preset_key: string | null; preset_ref: string | null },
  pathPrefix: string,
): Promise<CreatedRow> {
  if (ctx.siblings.length >= FIELD_LIMITS.perProduct) {
    throw fieldLimit(FIELD_LIMITS.perProduct);
  }
  if (
    parentId !== null &&
    ctx.siblings.filter((s) => s.parent_id === parentId).length >=
      FIELD_LIMITS.perRepeater
  ) {
    throw fieldLimit(FIELD_LIMITS.perRepeater);
  }
  const issues = [
    ...validateFieldConfig(
      {
        name: draft.name,
        type: draft.type,
        parent_id: parentId,
        sort_order: sortOrder,
        options: draft.options ?? null,
        linked_validation: draft.linked_validation ?? null,
        conditions: json(draft.conditions) ?? null,
        pricing: json(draft.pricing) ?? null,
        repeat: json(draft.repeat) ?? null,
        ui: json(draft.ui) ?? null,
      },
      ctx.siblings,
      ctx.optionConfig,
    ),
    ...draft.translations.flatMap((t, i) =>
      validateTranslationExtras(
        t as unknown as Record<string, unknown>,
        `translations[${i}]`,
      ),
    ),
  ];
  if (issues.length > 0) throw configInvalid(prefixed(issues, pathPrefix));

  // M4.0 checks (coded CUSTOM_FIELD_* 400s); null/undefined → not written.
  const options = sanitizeOptions(draft.options ?? undefined);
  const rules = sanitizeValidationRules(draft.validation_rules ?? undefined);
  const link = sanitizeLinkedValidation(draft.linked_validation ?? undefined, {
    name: draft.name,
  });
  const created = await tx.productCustomField.create({
    data: {
      product_id: ctx.productId,
      name: draft.name,
      type: draft.type as Prisma.ProductCustomFieldCreateInput['type'],
      is_required: draft.is_required,
      placeholder: draft.placeholder ?? null,
      sort_order: sortOrder,
      ...(parentId ? { parent_id: parentId } : {}),
      ...(options !== undefined && options !== Prisma.DbNull
        ? { options }
        : {}),
      ...(rules !== undefined && rules !== Prisma.DbNull
        ? { validation_rules: rules }
        : {}),
      ...(link !== undefined && link !== Prisma.DbNull
        ? { linked_validation: link }
        : {}),
      conditions: json(draft.conditions),
      pricing: json(draft.pricing),
      repeat: json(draft.repeat),
      ui: json(draft.ui),
      preset_key: meta.preset_key,
      preset_ref: meta.preset_ref,
      translations: { create: translationRows(draft.translations) },
    },
    include: fieldInclude,
  });
  ctx.siblings.push({
    id: created.id,
    name: created.name,
    type: created.type,
    parent_id: parentId,
    sort_order: sortOrder,
  });
  return created;
}

/** Creates a top-level draft and its children; returns the tree. */
export async function createFieldTree(
  tx: Prisma.TransactionClient,
  ctx: FieldWriteContext,
  draft: FieldDraft,
  meta: { preset_key: string | null; preset_ref: string | null },
): Promise<CreatedField> {
  const sortOrder = ctx.nextSortOrder++;
  const parent = await createOne(
    tx,
    ctx,
    draft,
    null,
    sortOrder,
    meta,
    draft.name,
  );
  const children: CreatedRow[] = [];
  if (draft.type === 'REPEATER') {
    const kids = draft.children ?? [];
    for (let i = 0; i < kids.length; i++) {
      children.push(
        await createOne(
          tx,
          ctx,
          kids[i],
          parent.id,
          i,
          meta,
          `${draft.name}.children[${i}]`,
        ),
      );
    }
  } else if ((draft.children ?? []).length > 0) {
    throw configInvalid([
      { path: `${draft.name}.children`, code: 'REPEATER_ONLY' },
    ]);
  }
  return { ...parent, children };
}

/**
 * The per-product advisory lock every field write takes (custom-field
 * create / update / reorder, presets, library inserts), held until the
 * transaction ends.
 */
export async function lockProductFields(
  tx: Prisma.TransactionClient,
  productId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`pfields:${productId}`}))`;
}

/** Who applies: a dashboard user (owner gate) or the importer (`system`). */
export type FieldWriteActor = { userId: string; role: UserRole } | 'system';

export interface ProductForWrite {
  id: string;
  creatorId: string;
  optionConfig: unknown;
  primaryLocale: string;
}

/**
 * Serializes field writes of one product (presets, library inserts) and
 * loads it with the owner gate of `CustomFieldsService.assertCanManage`:
 * ADMIN and `system` pass, a CREATOR must own the product. Advanced fields
 * exist only on creator products (D2).
 */
export async function lockProductForWrite(
  tx: Prisma.TransactionClient,
  productId: string,
  actor: FieldWriteActor,
): Promise<ProductForWrite> {
  await lockProductFields(tx, productId);
  const product = await tx.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      creator_id: true,
      variant_option_config: true,
      creator: {
        select: {
          user_id: true,
          store: {
            select: { language_config: { select: { primary_locale: true } } },
          },
        },
      },
    },
  });
  if (!product) {
    throw new NotFoundException({
      code: 'CUSTOM_FIELD_PRODUCT_NOT_FOUND',
      message: 'Product not found',
    });
  }
  if (
    actor !== 'system' &&
    actor.role !== UserRole.ADMIN &&
    !(
      actor.role === UserRole.CREATOR &&
      !!actor.userId &&
      product.creator?.user_id === actor.userId
    )
  ) {
    throw new ForbiddenException({
      code: 'CUSTOM_FIELD_FORBIDDEN',
      message: 'Not your product',
    });
  }
  if (!product.creator_id) throw creatorProductOnly();
  return {
    id: product.id,
    creatorId: product.creator_id,
    optionConfig: product.variant_option_config,
    primaryLocale:
      product.creator?.store?.language_config?.primary_locale ?? 'en',
  };
}

/** The product's fields as config siblings. */
export async function loadFieldSiblings(
  tx: Prisma.TransactionClient,
  productId: string,
) {
  return tx.productCustomField.findMany({
    where: { product_id: productId },
    select: {
      id: true,
      name: true,
      type: true,
      parent_id: true,
      sort_order: true,
      preset_key: true,
    },
    orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
  });
}
