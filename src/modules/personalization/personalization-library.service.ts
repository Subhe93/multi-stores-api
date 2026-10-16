import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  P_FIELD_TYPES,
  REPEATER_CHILD_TYPES,
} from '../../common/personalization/types';
import { isPlainObject } from '../../common/personalization/rules';
import {
  sanitizeLinkedValidation,
  sanitizeValidationRules,
} from '../custom-fields/custom-field-definition';
import { validateTranslationExtras } from './personalization-config.validator';
import {
  createFieldTree,
  type CreatedField,
  loadFieldSiblings,
  lockProductForWrite,
  nextTopSortOrder,
} from './personalization-field-writer';
import {
  configInvalid,
  PERSONALIZATION_TEMPLATE_LIMIT,
  templateNotFound,
  type ConfigIssue,
} from './personalization.errors';
import type { DraftTranslation, FieldDraft } from './presets/preset.types';

/** `PersonalizationFieldTemplate.definition` (no ids, D13). */
export interface TemplateDefinition {
  field: FieldDraft;
  children?: FieldDraft[];
}

export const LIBRARY_LIMITS = {
  templatesPerStore: 200,
  nameLength: 120,
  definitionBytes: 64 * 1024,
  children: 20,
  translations: 20,
  options: 200,
  fieldNameLength: 100,
} as const;

const DRAFT_KEYS = new Set([
  'name',
  'type',
  'is_required',
  'placeholder',
  'options',
  'validation_rules',
  'linked_validation',
  'conditions',
  'pricing',
  'repeat',
  'ui',
  'translations',
]);
const TRANSLATION_KEYS = [
  'locale',
  'label',
  'placeholder',
  'option_labels',
  'display_label',
  'sublabel',
  'note',
  'help_text',
  'help_image_url',
  'messages',
] as const;
const CONFIG_KEYS = ['conditions', 'pricing', 'repeat', 'ui'] as const;

const templateSelect = {
  id: true,
  name: true,
  definition: true,
  created_at: true,
  updated_at: true,
} as const;

function codeOf(err: unknown): string {
  if (err instanceof HttpException) {
    const body = err.getResponse();
    if (isPlainObject(body) && typeof body.code === 'string') return body.code;
  }
  return 'INVALID_VALUE';
}

/** Structural check of one draft; returns the normalized draft. */
function checkDraft(
  raw: unknown,
  path: string,
  child: boolean,
  out: ConfigIssue[],
): FieldDraft | null {
  if (!isPlainObject(raw)) {
    out.push({ path, code: 'INVALID_SHAPE' });
    return null;
  }
  for (const k of Object.keys(raw)) {
    if (!DRAFT_KEYS.has(k))
      out.push({ path: `${path}.${k}`, code: 'UNKNOWN_KEY' });
  }
  const name = raw.name;
  if (
    typeof name !== 'string' ||
    name.trim() === '' ||
    name.length > LIBRARY_LIMITS.fieldNameLength
  ) {
    out.push({ path: `${path}.name`, code: 'INVALID_VALUE' });
  }
  const type = raw.type;
  if (
    typeof type !== 'string' ||
    !(P_FIELD_TYPES as readonly string[]).includes(type)
  ) {
    out.push({ path: `${path}.type`, code: 'INVALID_TYPE' });
  } else if (child && !REPEATER_CHILD_TYPES.has(type)) {
    out.push({ path: `${path}.type`, code: 'CHILD_TYPE_NOT_ALLOWED' });
  }
  if (raw.is_required !== undefined && typeof raw.is_required !== 'boolean') {
    out.push({ path: `${path}.is_required`, code: 'INVALID_VALUE' });
  }
  if (
    raw.placeholder !== undefined &&
    raw.placeholder !== null &&
    typeof raw.placeholder !== 'string'
  ) {
    out.push({ path: `${path}.placeholder`, code: 'INVALID_VALUE' });
  }
  const options = raw.options;
  if (
    options !== undefined &&
    options !== null &&
    !(
      Array.isArray(options) &&
      options.length <= LIBRARY_LIMITS.options &&
      options.every((o) => typeof o === 'string')
    )
  ) {
    out.push({ path: `${path}.options`, code: 'INVALID_VALUE' });
  }
  for (const k of CONFIG_KEYS) {
    const v = raw[k];
    if (v !== undefined && v !== null && !isPlainObject(v)) {
      out.push({ path: `${path}.${k}`, code: 'INVALID_SHAPE' });
    }
  }
  // M4.0 rule checks (pattern, allowed_chars, bounds, link shape).
  try {
    sanitizeValidationRules(raw.validation_rules ?? undefined);
  } catch (err) {
    out.push({ path: `${path}.validation_rules`, code: codeOf(err) });
  }
  try {
    sanitizeLinkedValidation(raw.linked_validation ?? undefined, {
      name: typeof name === 'string' ? name : null,
    });
  } catch (err) {
    out.push({ path: `${path}.linked_validation`, code: codeOf(err) });
  }

  const translations: DraftTranslation[] = [];
  const list = raw.translations ?? [];
  if (!Array.isArray(list) || list.length > LIBRARY_LIMITS.translations) {
    out.push({ path: `${path}.translations`, code: 'INVALID_SHAPE' });
  } else {
    list.forEach((t: unknown, i: number) => {
      const tp = `${path}.translations[${i}]`;
      if (!isPlainObject(t)) {
        out.push({ path: tp, code: 'INVALID_SHAPE' });
        return;
      }
      for (const k of Object.keys(t)) {
        if (!(TRANSLATION_KEYS as readonly string[]).includes(k)) {
          out.push({ path: `${tp}.${k}`, code: 'UNKNOWN_KEY' });
        }
      }
      if (
        typeof t.locale !== 'string' ||
        !/^[a-z]{2}(-[A-Za-z]{2})?$/.test(t.locale)
      ) {
        out.push({ path: `${tp}.locale`, code: 'INVALID_VALUE' });
      }
      if (typeof t.label !== 'string' || t.label.length > 2000) {
        out.push({ path: `${tp}.label`, code: 'INVALID_VALUE' });
      }
      if (
        t.placeholder !== undefined &&
        t.placeholder !== null &&
        typeof t.placeholder !== 'string'
      ) {
        out.push({ path: `${tp}.placeholder`, code: 'INVALID_VALUE' });
      }
      if (
        t.option_labels !== undefined &&
        t.option_labels !== null &&
        !isPlainObject(t.option_labels)
      ) {
        out.push({ path: `${tp}.option_labels`, code: 'INVALID_SHAPE' });
      }
      out.push(...validateTranslationExtras(t, tp));
      translations.push(t as unknown as DraftTranslation);
    });
  }
  return {
    name: typeof name === 'string' ? name.trim() : '',
    type: typeof type === 'string' ? type : 'TEXT',
    is_required: raw.is_required === true,
    placeholder: typeof raw.placeholder === 'string' ? raw.placeholder : null,
    options: Array.isArray(options) ? (options as string[]) : null,
    validation_rules: isPlainObject(raw.validation_rules)
      ? raw.validation_rules
      : null,
    linked_validation: isPlainObject(raw.linked_validation)
      ? raw.linked_validation
      : null,
    conditions: isPlainObject(raw.conditions) ? raw.conditions : null,
    pricing: isPlainObject(raw.pricing) ? raw.pricing : null,
    repeat: isPlainObject(raw.repeat) ? raw.repeat : null,
    ui: isPlainObject(raw.ui) ? raw.ui : null,
    translations,
  };
}

/**
 * Structural check of a template definition (product-specific rules —
 * option names, field references — are checked when it is inserted).
 */
export function validateTemplateDefinition(raw: unknown): {
  definition: TemplateDefinition | null;
  errors: ConfigIssue[];
} {
  const errors: ConfigIssue[] = [];
  if (!isPlainObject(raw)) {
    return {
      definition: null,
      errors: [{ path: 'definition', code: 'INVALID_SHAPE' }],
    };
  }
  if (JSON.stringify(raw).length > LIBRARY_LIMITS.definitionBytes) {
    return {
      definition: null,
      errors: [{ path: 'definition', code: 'TOO_LONG' }],
    };
  }
  for (const k of Object.keys(raw)) {
    if (k !== 'field' && k !== 'children') {
      errors.push({ path: `definition.${k}`, code: 'UNKNOWN_KEY' });
    }
  }
  const field = checkDraft(raw.field, 'definition.field', false, errors);
  const children: FieldDraft[] = [];
  const rawChildren = raw.children ?? [];
  if (
    !Array.isArray(rawChildren) ||
    rawChildren.length > LIBRARY_LIMITS.children
  ) {
    errors.push({ path: 'definition.children', code: 'INVALID_SHAPE' });
  } else if (rawChildren.length > 0 && field?.type !== 'REPEATER') {
    errors.push({ path: 'definition.children', code: 'REPEATER_ONLY' });
  } else {
    const names = new Set<string>();
    rawChildren.forEach((c: unknown, i: number) => {
      const d = checkDraft(c, `definition.children[${i}]`, true, errors);
      if (!d) return;
      if (names.has(d.name)) {
        errors.push({
          path: `definition.children[${i}].name`,
          code: 'DUPLICATE_VALUE',
        });
      }
      names.add(d.name);
      if (d.conditions) {
        errors.push({
          path: `definition.children[${i}].conditions`,
          code: 'CHILD_NO_CONDITIONS',
        });
      }
      children.push(d);
    });
  }
  if (errors.length > 0 || !field) return { definition: null, errors };
  return {
    definition: field.type === 'REPEATER' ? { field, children } : { field },
    errors,
  };
}

type FieldRow = Prisma.ProductCustomFieldGetPayload<{
  include: { translations: true };
}>;

/** A stored field as a draft (ids, product, parent, order and preset stripped). */
function draftOf(row: FieldRow): FieldDraft {
  const translations = row.translations.map((t) => {
    const out: Record<string, unknown> = { locale: t.locale, label: t.label };
    for (const k of TRANSLATION_KEYS) {
      if (k === 'locale' || k === 'label') continue;
      const v = (t as Record<string, unknown>)[k];
      if (v !== null && v !== undefined) out[k] = v;
    }
    return out as unknown as DraftTranslation;
  });
  const obj = (v: unknown) => (isPlainObject(v) ? v : null);
  return {
    name: row.name,
    type: row.type,
    is_required: row.is_required,
    placeholder: row.placeholder,
    options: Array.isArray(row.options)
      ? row.options.filter((o): o is string => typeof o === 'string')
      : null,
    validation_rules: obj(row.validation_rules),
    linked_validation: obj(row.linked_validation),
    conditions: obj(row.conditions),
    pricing: obj(row.pricing),
    repeat: obj(row.repeat),
    ui: obj(row.ui),
    translations,
  };
}

/**
 * A sibling link whose target (or legacy `target_field_id`) is a field id
 * of `nameOf`, rewritten to `target: <name>`; other links are unchanged.
 */
export function remapLinkTarget(
  link: Record<string, unknown> | null,
  nameOf: ReadonlyMap<string, string>,
): Record<string, unknown> | null {
  if (!link) return link;
  const target = typeof link.target === 'string' ? link.target.trim() : '';
  const legacy =
    typeof link.target_field_id === 'string' ? link.target_field_id : '';
  const name = nameOf.get(target) ?? nameOf.get(legacy);
  if (name === undefined) return link;
  const { target_field_id: _legacy, ...rest } = link;
  return { ...rest, target: name };
}

/**
 * Store-scoped field library (M4.1 D13): templates are saved from a field
 * or sent as a definition, and inserted into the creator's own products
 * with the same checks as presets.
 */
@Injectable()
export class PersonalizationLibraryService {
  constructor(private readonly prisma: PrismaService) {}

  list(storeId: string) {
    return this.prisma.personalizationFieldTemplate.findMany({
      where: { store_id: storeId },
      select: templateSelect,
      orderBy: [{ updated_at: 'desc' }, { id: 'asc' }],
    });
  }

  /** `{name, definition}` or `{name, from_field_id}` (a field of the creator's own product). */
  async create(
    storeId: string,
    userId: string,
    input: { name: string; definition?: unknown; from_field_id?: string },
  ) {
    const definition = input.from_field_id
      ? await this.definitionFromField(userId, input.from_field_id)
      : this.checkedDefinition(input.definition);
    // Count and insert under a per-store advisory lock, so two concurrent
    // saves cannot both pass the limit.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`plibrary:${storeId}`}))`;
      const count = await tx.personalizationFieldTemplate.count({
        where: { store_id: storeId },
      });
      if (count >= LIBRARY_LIMITS.templatesPerStore) {
        throw new BadRequestException({
          code: PERSONALIZATION_TEMPLATE_LIMIT,
          message: `A store can keep at most ${LIBRARY_LIMITS.templatesPerStore} field templates`,
          params: { max: LIBRARY_LIMITS.templatesPerStore },
        });
      }
      return tx.personalizationFieldTemplate.create({
        data: {
          store_id: storeId,
          name: input.name.trim(),
          definition: definition as unknown as Prisma.InputJsonValue,
        },
        select: templateSelect,
      });
    });
  }

  async update(
    storeId: string,
    id: string,
    input: { name?: string; definition?: unknown },
  ) {
    await this.findOrThrow(storeId, id);
    return this.prisma.personalizationFieldTemplate.update({
      where: { id },
      data: {
        ...(input.name !== undefined && { name: input.name.trim() }),
        ...(input.definition !== undefined && {
          definition: this.checkedDefinition(
            input.definition,
          ) as unknown as Prisma.InputJsonValue,
        }),
      },
      select: templateSelect,
    });
  }

  async remove(storeId: string, id: string) {
    const res = await this.prisma.personalizationFieldTemplate.deleteMany({
      where: { id, store_id: storeId },
    });
    if (res.count === 0) throw templateNotFound();
    return { id, deleted: true };
  }

  /** Inserts a template at the end of a product's fields; returns the created tree. */
  async insertIntoProduct(
    storeId: string,
    userId: string,
    templateId: string,
    productId: string,
  ): Promise<CreatedField[]> {
    const template = await this.findOrThrow(storeId, templateId);
    const { definition, errors } = validateTemplateDefinition(
      template.definition,
    );
    if (!definition) throw configInvalid(errors);
    return this.prisma.$transaction(
      async (tx) => {
        const product = await lockProductForWrite(tx, productId, {
          userId,
          role: UserRole.CREATOR,
        });
        const existing = await loadFieldSiblings(tx, productId);
        const name = definition.field.name;
        if (existing.some((f) => !f.parent_id && f.name === name)) {
          throw new ConflictException({
            code: 'CUSTOM_FIELD_NAME_TAKEN',
            message: `Another field of this product is already named "${name}"`,
            params: { name },
          });
        }
        const ctx = {
          productId,
          optionConfig: product.optionConfig,
          siblings: existing.map((f) => ({
            id: f.id,
            name: f.name,
            type: f.type,
            parent_id: f.parent_id,
            sort_order: f.sort_order,
          })),
          nextSortOrder: await nextTopSortOrder(tx, productId),
        };
        const created = await createFieldTree(
          tx,
          ctx,
          { ...definition.field, children: definition.children ?? [] },
          { preset_key: null, preset_ref: null },
        );
        return [created];
      },
      { timeout: 20_000 },
    );
  }

  private checkedDefinition(raw: unknown): TemplateDefinition {
    const { definition, errors } = validateTemplateDefinition(raw);
    if (!definition) throw configInvalid(errors);
    return definition;
  }

  private async definitionFromField(
    userId: string,
    fieldId: string,
  ): Promise<TemplateDefinition> {
    const field = await this.prisma.productCustomField.findFirst({
      where: { id: fieldId, product: { creator: { user_id: userId } } },
      include: {
        translations: true,
        children: {
          include: { translations: true },
          orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!field) {
      throw new NotFoundException({
        code: 'CUSTOM_FIELD_NOT_FOUND',
        message: 'Custom field not found',
      });
    }
    // A child is saved on its own (it becomes a top-level field on insert):
    // a link to one of its sibling children cannot resolve there, so it is
    // dropped. A repeater's children keep their links, with a legacy id
    // target remapped to the sibling's name (the copies get new ids).
    const draft = draftOf(field);
    if (field.parent_id)
      return { field: { ...draft, linked_validation: null } };
    if (field.type !== 'REPEATER') return { field: draft };
    const nameOf = new Map(field.children.map((c) => [c.id, c.name]));
    const children = field.children.map((c) => {
      const d = draftOf(c);
      return {
        ...d,
        linked_validation: remapLinkTarget(d.linked_validation ?? null, nameOf),
      };
    });
    return { field: draft, children };
  }

  private async findOrThrow(storeId: string, id: string) {
    const row = await this.prisma.personalizationFieldTemplate.findFirst({
      where: { id, store_id: storeId },
      select: templateSelect,
    });
    if (!row) throw templateNotFound();
    return row;
  }
}
