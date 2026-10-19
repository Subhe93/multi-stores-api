import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { RevalidationService } from '../../common/revalidation/revalidation.service';
import { Prisma, UserRole } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  CreateCustomFieldDto,
  CustomFieldTranslationDto,
  UpdateCustomFieldDto,
} from './dto/custom-field.dto';
import { isPlainObject } from '@multi-stores/core/personalization/rules';
import { StoreAppsService } from '../store-apps/store-apps.service';
import {
  shapeFieldsForStorefront,
  usesAdvancedFields,
} from '../personalization/personalization-runtime';
import type { PFieldDef } from '@multi-stores/core/personalization/types';
import { ProductStatus } from '@prisma/client';
import {
  CUSTOM_FIELD_IN_USE,
  CUSTOM_FIELD_INVALID_LINK,
  CUSTOM_FIELD_NAME_TAKEN,
  sanitizeLinkedValidation,
  sanitizeOptions,
  sanitizeValidationRules,
} from './custom-field-definition';
import {
  isAppOnlyType,
  TRANSLATION_EXTRA_KEYS,
  type TranslationExtraKey,
  validateFieldConfig,
  validateTranslationExtras,
} from '../personalization/personalization-config.validator';
import {
  appRequired,
  configInvalid,
  creatorProductOnly,
  FIELD_LIMITS,
  fieldInUse,
  fieldLimit,
  type ConfigIssue,
} from '../personalization/personalization.errors';
import {
  fieldReferencesTo,
  jsonEqual,
  renameFieldReferences,
} from '../personalization/personalization-json';
import { lockProductFields } from '../personalization/personalization-field-writer';

/** The four JSON config columns of the personalization app (M4.1 §2). */
const CONFIG_KEYS = ['conditions', 'pricing', 'repeat', 'ui'] as const;
type ConfigKey = (typeof CONFIG_KEYS)[number];

type JsonWrite = Prisma.InputJsonValue | typeof Prisma.DbNull;

/** The Prisma client a helper runs on (the service's, or a transaction's). */
type Db = Prisma.TransactionClient | PrismaService;

type StoredTranslation = { locale: string } & Partial<
  Record<TranslationExtraKey, unknown>
>;

/** A field row as the write paths read it. */
interface StoredField {
  id: string;
  product_id: string;
  name: string;
  type?: string;
  parent_id?: string | null;
  sort_order?: number | null;
  options?: unknown;
  validation_rules?: unknown;
  linked_validation?: unknown;
  conditions?: unknown;
  pricing?: unknown;
  repeat?: unknown;
  ui?: unknown;
}

function isFilled(v: unknown): boolean {
  if (v === undefined || v === null || v === '') return false;
  if (isPlainObject(v)) return Object.keys(v).length > 0;
  return true;
}

/**
 * An empty config object (`{}`) is stored as NULL: it configures nothing,
 * and `{}` in a JSON column would otherwise count as M4.1 config.
 */
function withEmptyConfigAsNull<T extends Partial<Record<ConfigKey, unknown>>>(
  dto: T,
): T {
  const out = { ...dto };
  for (const k of CONFIG_KEYS) {
    const v = out[k];
    if (isPlainObject(v) && Object.keys(v).length === 0) {
      (out as Record<string, unknown>)[k] = null;
    }
  }
  return out;
}

/** `min_checked` / `max_checked` set in a rules object (CHECKBOX_GROUP, app only). */
function checkedRules(rules: unknown): Record<string, unknown> {
  if (!isPlainObject(rules)) return {};
  const out: Record<string, unknown> = {};
  for (const k of ['min_checked', 'max_checked']) {
    if (isFilled(rules[k])) out[k] = rules[k];
  }
  return out;
}

@Injectable()
export class CustomFieldsService {
  private readonly logger = new Logger(CustomFieldsService.name);

  constructor(
    private prisma: PrismaService,
    // Global module; optional so the service also runs without it (the
    // personalization app then counts as disabled).
    @Optional() private storeApps?: StoreAppsService,
    // Global module; optional and trailing (positional unit tests). Absent
    // = no storefront revalidation (the time-based fallback catches up).
    @Optional() private readonly revalidation?: RevalidationService,
  ) {}

  /**
   * D13: the storefront caches product pages with their fields; every
   * field write of a creator product drops that cache. Fire-and-forget: a
   * failed revalidation never fails the write.
   */
  private revalidateProduct(creatorId: string | null | undefined): void {
    if (!creatorId || !this.revalidation) return;
    void this.revalidation
      .revalidateStoreByCreatorId(creatorId)
      .catch((e: unknown) => {
        this.logger.warn(
          `Storefront revalidation failed for creator ${creatorId}: ${String(e)}`,
        );
      });
  }

  async create(
    productId: string,
    input: CreateCustomFieldDto,
    userId: string,
    role: UserRole,
  ) {
    const product = await this.assertCanManage(productId, userId, role);
    const dto = withEmptyConfigAsNull(input);

    const {
      translations,
      options,
      validation_rules,
      linked_validation,
      parent_id,
      conditions,
      pricing,
      repeat,
      ui,
      preset_key,
      preset_ref,
      ...data
    } = dto;
    const parentId = parent_id ?? null;
    // M4.0 (§3.2): merchant rules are checked and normalized before saving.
    const rules = this.sanitizeRules(
      { options, validation_rules, linked_validation },
      { name: dto.name },
    );

    // M4.1 gate: any app-only feature needs the app on a creator product.
    const advanced =
      isAppOnlyType(dto.type) ||
      parentId !== null ||
      CONFIG_KEYS.some((k) => isFilled(dto[k])) ||
      Object.keys(checkedRules(validation_rules)).length > 0 ||
      (translations ?? []).some((t) =>
        TRANSLATION_EXTRA_KEYS.some((k) => isFilled(t[k])),
      );

    // Field writes of one product are serialized (same advisory lock as
    // presets and library inserts), so the checks below see every row.
    const created = await this.prisma.$transaction(async (tx) => {
      await lockProductFields(tx, productId);
      const siblings = await this.loadSiblings(tx, productId);
      this.assertFieldLimits(siblings, parentId);
      await this.assertNameFree(tx, productId, parentId, dto.name);
      await this.assertLinkTarget(
        tx,
        productId,
        parentId,
        rules.linked_validation,
      );

      // A field added without an explicit position goes last, so snapshot,
      // order and email rows keep the order the merchant created them in.
      // A repeater child goes last among its siblings.
      let sortOrder = data.sort_order;
      if (sortOrder === undefined || sortOrder === null) {
        const last = await tx.productCustomField.aggregate({
          where:
            parentId === null
              ? { product_id: productId }
              : { product_id: productId, parent_id: parentId },
          _max: { sort_order: true },
        });
        const max = last?._max?.sort_order;
        sortOrder = typeof max === 'number' ? max + 1 : 0;
      }

      if (advanced) {
        const optionConfig = await this.assertAppForProduct(productId);
        const issues = [
          ...validateFieldConfig(
            {
              name: dto.name,
              type: dto.type,
              parent_id: parentId,
              sort_order: sortOrder,
              options,
              linked_validation: linked_validation ?? null,
              conditions,
              pricing,
              repeat,
              ui,
            },
            siblings,
            optionConfig,
          ),
          ...this.translationIssues(translations),
        ];
        if (issues.length > 0) throw configInvalid(issues);
      }

      return tx.productCustomField.create({
        data: {
          product_id: productId,
          ...data,
          sort_order: sortOrder,
          ...rules,
          ...this.personalizationData(
            {
              parent_id: parentId,
              conditions,
              pricing,
              repeat,
              ui,
              preset_key,
              preset_ref,
            },
            'create',
          ),
          ...(translations && {
            translations: {
              create: translations.map((t) =>
                this.translationRow(t, undefined),
              ),
            },
          }),
        },
        include: { translations: true },
      });
    });
    this.revalidateProduct(product.creator_id);
    return created;
  }

  async findByProduct(productId: string) {
    return this.prisma.productCustomField.findMany({
      where: { product_id: productId },
      include: { translations: true },
      // id breaks sort_order ties (same order as every other reader).
      orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });
  }

  /**
   * Public read (`GET products/:id/custom-fields`, M4.1 WP-C). Only for a
   * PUBLISHED product (404 otherwise, like the storefront). The preset
   * bookkeeping keys are never returned. Without the app in effect for the
   * product (D2) the rows have the storefront D10 shape: top-level fields of
   * M4.0 types without the M4.1 columns, so rows of a product without M4.1
   * config are byte-identical to the M4.0 response; with the app on, every
   * other column (flat rows, the field row contract).
   */
  async findPublicByProduct(productId: string) {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { creator_id: true, status: true },
    });
    if (!product || product.status !== ProductStatus.PUBLISHED) {
      throw new NotFoundException({
        code: 'CUSTOM_FIELD_PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });
    }
    const rows = await this.findByProduct(productId);
    const legacy = () => shapeFieldsForStorefront(rows, false);
    // No M4.1 feature anywhere: the M4.0 rows, without asking for the app.
    if (!usesAdvancedFields(rows as unknown as PFieldDef[])) return legacy();
    const store = product.creator_id
      ? await this.prisma.store.findUnique({
          where: { creator_id: product.creator_id },
          select: { id: true },
        })
      : null;
    const on =
      !!store &&
      !!this.storeApps &&
      (await this.storeApps.isEnabled(store.id, 'personalization'));
    if (!on) return legacy();
    return rows.map(({ preset_key: _key, preset_ref: _ref, ...row }) => row);
  }

  /**
   * Updates one field. One transaction under the product's field lock: the
   * field is re-read, the stored translations (X19), every check and every
   * write. Steps: `computeGate` (does this write need the app, or a tree
   * re-check?), `validateMerged` (the merged definition against its
   * siblings), the name/link checks, `writeField`, then `propagateRename`
   * (sibling links, conditions, repeater leads, `url_prefill`).
   */
  async update(
    id: string,
    input: UpdateCustomFieldDto,
    userId: string,
    role: UserRole,
  ) {
    const current = await this.findFieldOrThrow(id);
    const product = await this.assertCanManage(
      current.product_id,
      userId,
      role,
    );
    const dto = withEmptyConfigAsNull(input);
    let renamedStoreId: string | null = null;
    const updated = await this.prisma.$transaction(async (tx) => {
      await lockProductFields(tx, current.product_id);
      const field = await this.findFieldOrThrow(id, tx);
      const parentId = field.parent_id ?? null;
      const {
        parent_id,
        translations,
        options,
        validation_rules,
        linked_validation,
      } = dto;
      if (parent_id !== undefined && (parent_id ?? null) !== parentId) {
        // Moving a field between repeaters is not supported (delete and add).
        throw configInvalid([{ path: 'parent_id', code: 'PARENT_IMMUTABLE' }]);
      }
      const rules = this.sanitizeRules(
        { options, validation_rules, linked_validation },
        { name: dto.name ?? field.name, id },
      );
      const storedByLocale = await this.storedTranslations(
        tx,
        id,
        translations,
      );

      const gate = this.computeGate(dto, field, storedByLocale);
      if (gate.validate) {
        await this.validateMerged(tx, field, dto, rules, gate.introduced);
      }
      if (gate.reordered) {
        // M5 A13: a new position can make a reference of this field, or a
        // reference to it, a forward one (same check as `reorder`).
        await this.assertOrderReferences(
          tx,
          field.product_id,
          new Map([[id, dto.sort_order as number]]),
        );
      }

      const renamed = dto.name !== undefined && dto.name !== field.name;
      if (renamed) {
        await this.assertNameFree(tx, field.product_id, parentId, dto.name, id);
      }
      await this.assertLinkTarget(
        tx,
        field.product_id,
        parentId,
        rules.linked_validation,
        id,
      );

      const row = await this.writeField(tx, id, dto, rules, storedByLocale);
      if (renamed && dto.name) {
        renamedStoreId = await this.propagateRename(
          tx,
          field,
          parentId,
          dto.name,
        );
      }
      return row;
    });
    // The store's app settings changed (url_prefill): drop the cached copy.
    if (renamedStoreId && this.storeApps) {
      await this.storeApps.settingsChanged(renamedStoreId);
    }
    this.revalidateProduct(product.creator_id);
    return updated;
  }

  /**
   * X19: the stored M4.1 translation columns, read before the
   * delete-and-recreate so a save that omits them keeps them. Not read when
   * the write carries no translations (unchanged M4.0 path).
   */
  private async storedTranslations(
    tx: Prisma.TransactionClient,
    fieldId: string,
    translations: CustomFieldTranslationDto[] | undefined,
  ): Promise<Map<string, StoredTranslation>> {
    if (!translations) return new Map();
    const stored: StoredTranslation[] =
      await tx.customFieldTranslation.findMany({
        where: { field_id: fieldId },
        select: {
          locale: true,
          display_label: true,
          sublabel: true,
          note: true,
          help_text: true,
          help_image_url: true,
          messages: true,
        },
      });
    return new Map(stored.map((t) => [t.locale, t]));
  }

  /**
   * M4.1 gate of an update. `introduced`: the write introduces app-only
   * config (a changed advanced value, type, checked rule or translation
   * column), so the app must be on (a save from the app-off editor that
   * round-trips stored keys still works). `validate`: the merged definition
   * must be re-validated (introduced, or a type change / cleared config on
   * a repeater or child, which can break the tree rules). `reordered`: the
   * write moves the field (M5 A13).
   */
  private computeGate(
    dto: UpdateCustomFieldDto,
    field: StoredField,
    storedByLocale: Map<string, StoredTranslation>,
  ): { introduced: boolean; validate: boolean; reordered: boolean } {
    const { translations, validation_rules } = dto;
    const parentId = field.parent_id ?? null;
    const introduced =
      (dto.type !== undefined &&
        isAppOnlyType(dto.type) &&
        dto.type !== field.type) ||
      CONFIG_KEYS.some(
        (k) => isFilled(dto[k]) && !jsonEqual(dto[k], field[k] ?? null),
      ) ||
      Object.entries(checkedRules(validation_rules)).some(
        ([k, v]) =>
          !jsonEqual(
            v,
            isPlainObject(field.validation_rules)
              ? (field.validation_rules[k] ?? null)
              : null,
          ),
      ) ||
      (translations ?? []).some((t) =>
        TRANSLATION_EXTRA_KEYS.some(
          (k) =>
            isFilled(t[k]) &&
            !jsonEqual(t[k], storedByLocale.get(t.locale)?.[k] ?? null),
        ),
      );
    const typeChanged = dto.type !== undefined && dto.type !== field.type;
    const treeField = parentId !== null || field.type === 'REPEATER';
    // Clearing config of a repeater or a child can break the tree rules
    // (a REPEATER without `repeat` → REPEAT_REQUIRED): checked too.
    const clearedConfig = CONFIG_KEYS.some(
      (k) => dto[k] === null && field[k] !== null && field[k] !== undefined,
    );
    const reordered =
      parentId === null &&
      typeof dto.sort_order === 'number' &&
      dto.sort_order !== (field.sort_order ?? null);
    return {
      introduced,
      validate: introduced || (treeField && (typeChanged || clearedConfig)),
      reordered,
    };
  }

  /**
   * Validates the field as it will be stored (DTO over the row) against its
   * siblings: the app gate when config is introduced (403/400), else only
   * the product's option config.
   */
  private async validateMerged(
    tx: Prisma.TransactionClient,
    field: StoredField,
    dto: UpdateCustomFieldDto,
    rules: ReturnType<CustomFieldsService['sanitizeRules']>,
    introduced: boolean,
  ): Promise<void> {
    const optionConfig = introduced
      ? await this.assertAppForProduct(field.product_id)
      : await this.optionConfigOf(field.product_id);
    const siblings = await this.loadSiblings(tx, field.product_id);
    const pick = <K extends ConfigKey>(k: K): unknown =>
      dto[k] !== undefined ? dto[k] : (field[k] ?? null);
    const merged = {
      id: field.id,
      name: dto.name ?? field.name,
      type: dto.type ?? field.type ?? 'TEXT',
      parent_id: field.parent_id ?? null,
      sort_order: dto.sort_order ?? field.sort_order ?? null,
      options: dto.options !== undefined ? dto.options : field.options,
      linked_validation:
        rules.linked_validation === undefined
          ? field.linked_validation
          : rules.linked_validation === Prisma.DbNull
            ? null
            : rules.linked_validation,
      conditions: pick('conditions'),
      pricing: pick('pricing'),
      repeat: pick('repeat'),
      ui: pick('ui'),
    };
    const hasChildren =
      field.type === 'REPEATER' &&
      siblings.some((s) => s.parent_id === field.id);
    const issues = [
      ...validateFieldConfig(merged, siblings, optionConfig, { hasChildren }),
      ...(introduced ? this.translationIssues(dto.translations) : []),
    ];
    if (issues.length > 0) throw configInvalid(issues);
  }

  /**
   * Writes the field row: scalar columns, the checked rules, the M4.1
   * config (`null` clears) and, when sent, the translations
   * (delete-and-recreate with the X19 carry-over).
   */
  private async writeField(
    tx: Prisma.TransactionClient,
    id: string,
    dto: UpdateCustomFieldDto,
    rules: ReturnType<CustomFieldsService['sanitizeRules']>,
    storedByLocale: Map<string, StoredTranslation>,
  ) {
    const {
      translations,
      options: _options,
      validation_rules: _rules,
      linked_validation: _link,
      parent_id: _parent,
      conditions,
      pricing,
      repeat,
      ui,
      preset_key,
      preset_ref,
      ...data
    } = dto;
    void _options;
    void _rules;
    void _link;
    void _parent;
    if (translations) {
      await tx.customFieldTranslation.deleteMany({ where: { field_id: id } });
    }
    return tx.productCustomField.update({
      where: { id },
      data: {
        ...data,
        ...rules,
        ...this.personalizationData(
          { conditions, pricing, repeat, ui, preset_key, preset_ref },
          'update',
        ),
        ...(translations && {
          translations: {
            create: translations.map((t) =>
              this.translationRow(t, storedByLocale.get(t.locale)),
            ),
          },
        }),
      },
      include: { translations: true },
    });
  }

  /**
   * After a rename: the sibling links that point at the old name (links
   * resolve by name, K3), the field-source conditions and repeater leads
   * of the other top-level fields, and the store's `url_prefill`. Returns
   * the store id when its settings changed.
   */
  private async propagateRename(
    tx: Prisma.TransactionClient,
    field: StoredField,
    parentId: string | null,
    newName: string,
  ): Promise<string | null> {
    await this.renameLinkTargets(
      tx,
      field.product_id,
      field.id,
      parentId,
      field.name,
      newName,
    );
    if (parentId !== null) return null;
    return this.renameUrlPrefill(
      tx,
      field.product_id,
      field.id,
      field.name,
      newName,
    );
  }

  /**
   * M4.1: with `overrides` applied to the top-level order, every field
   * reference must still point at an earlier field (FORWARD_REFERENCE →
   * 400 PERSONALIZATION_CONFIG_INVALID). Shared by `reorder` and an update
   * that moves a field (M5 A13).
   */
  private async assertOrderReferences(
    tx: Prisma.TransactionClient,
    productId: string,
    overrides: ReadonlyMap<string, number>,
  ): Promise<void> {
    const rows = await tx.productCustomField.findMany({
      where: { product_id: productId },
      select: {
        id: true,
        name: true,
        type: true,
        parent_id: true,
        sort_order: true,
        conditions: true,
        repeat: true,
      },
    });
    const next = rows.map((r) => ({
      ...r,
      sort_order: overrides.get(r.id) ?? r.sort_order,
    }));
    const issues = next
      .filter(
        (r) =>
          !r.parent_id &&
          ((r.conditions !== null && r.conditions !== undefined) ||
            (r.repeat !== null && r.repeat !== undefined)),
      )
      .flatMap((r) =>
        validateFieldConfig(r, next, null)
          .filter((i) => i.code === 'FORWARD_REFERENCE')
          .map((i) => ({ ...i, path: `${r.name}.${i.path}` })),
      );
    if (issues.length > 0) throw configInvalid(issues);
  }

  /**
   * Nested translation row. M4.1 columns: a value in the DTO wins (`null`
   * clears); `undefined` carries the stored value over (X19). Keys with
   * nothing to write are left out, so app-off rows are written as before.
   */
  private translationRow(
    t: CustomFieldTranslationDto,
    stored: StoredTranslation | undefined,
  ) {
    const {
      display_label,
      sublabel,
      note,
      help_text,
      help_image_url,
      messages,
      ...base
    } = t;
    const given: Record<TranslationExtraKey, unknown> = {
      display_label,
      sublabel,
      note,
      help_text,
      help_image_url,
      messages,
    };
    const extras: Record<string, unknown> = {};
    for (const k of TRANSLATION_EXTRA_KEYS) {
      const v = given[k] !== undefined ? given[k] : stored?.[k];
      if (v === undefined || v === null) continue;
      extras[k] = v;
    }
    return {
      ...base,
      ...extras,
    } as Prisma.CustomFieldTranslationCreateWithoutFieldInput;
  }

  /**
   * The M4.1 field columns to write. Undefined keys are left out; on update
   * `null` clears (SQL NULL for JSON); on create `null` is simply omitted.
   */
  private personalizationData(
    input: {
      parent_id?: string | null;
      conditions?: unknown;
      pricing?: unknown;
      repeat?: unknown;
      ui?: unknown;
      preset_key?: string | null;
      preset_ref?: string | null;
    },
    mode: 'create' | 'update',
  ) {
    const out: Record<string, JsonWrite | string | null> = {};
    if (input.parent_id) out.parent_id = input.parent_id;
    for (const k of CONFIG_KEYS) {
      const v = input[k];
      if (v === undefined) continue;
      if (v === null) {
        if (mode === 'update') out[k] = Prisma.DbNull;
        continue;
      }
      out[k] = v as Prisma.InputJsonValue;
    }
    for (const k of ['preset_key', 'preset_ref'] as const) {
      const v = input[k];
      if (v === undefined) continue;
      if (v === null || v === '') {
        if (mode === 'update') out[k] = null;
        continue;
      }
      out[k] = v;
    }
    return out;
  }

  private translationIssues(
    translations: CustomFieldTranslationDto[] | undefined,
  ): ConfigIssue[] {
    return (translations ?? []).flatMap((t, i) =>
      validateTranslationExtras(
        t as unknown as Record<string, unknown>,
        `translations[${i}]`,
      ),
    );
  }

  /**
   * M4.1 D2/D10 gate for advanced config: the product must be a creator's
   * own product (400 PERSONALIZATION_CREATOR_PRODUCT_ONLY) and the app must
   * be enabled for that creator's store (403 PERSONALIZATION_APP_REQUIRED).
   * Returns the product's `variant_option_config`.
   */
  private async assertAppForProduct(productId: string): Promise<unknown> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { creator_id: true, variant_option_config: true },
    });
    if (!product?.creator_id) throw creatorProductOnly();
    const store = await this.prisma.store.findUnique({
      where: { creator_id: product.creator_id },
      select: { id: true },
    });
    const on =
      !!store &&
      !!this.storeApps &&
      (await this.storeApps.isEnabled(store.id, 'personalization'));
    if (!on) throw appRequired();
    return product.variant_option_config;
  }

  private async optionConfigOf(productId: string): Promise<unknown> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: { variant_option_config: true },
    });
    return product?.variant_option_config ?? null;
  }

  private loadSiblings(db: Db, productId: string) {
    return db.productCustomField.findMany({
      where: { product_id: productId },
      select: {
        id: true,
        name: true,
        type: true,
        parent_id: true,
        sort_order: true,
      },
    });
  }

  /**
   * A `linked_validation.target` must name a sibling field (same product and
   * same parent, C16), or for legacy rows be a sibling's id. Not checked
   * when the link is absent or cleared.
   */
  private async assertLinkTarget(
    db: Db,
    productId: string,
    parentId: string | null,
    link: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined,
    selfId?: string,
  ) {
    if (!link || link === Prisma.DbNull || !isPlainObject(link)) return;
    const raw = (link as Record<string, unknown>).target;
    const target = typeof raw === 'string' ? raw : '';
    const siblings = await db.productCustomField.findMany({
      where: {
        product_id: productId,
        parent_id: parentId,
        ...(selfId ? { id: { not: selfId } } : {}),
      },
      select: { id: true, name: true },
    });
    if (!siblings.some((f) => f.name === target || f.id === target)) {
      throw new BadRequestException({
        code: CUSTOM_FIELD_INVALID_LINK,
        message: `linked_validation.target "${target}" is not another field of this product`,
        params: { target },
      });
    }
  }

  /**
   * Points references at the field's new name (same transaction): sibling
   * links (same parent), and for a top-level field also the field-source
   * conditions and repeater lead lists of the other top-level fields.
   */
  private async renameLinkTargets(
    tx: Prisma.TransactionClient,
    productId: string,
    selfId: string,
    parentId: string | null,
    oldName: string,
    newName: string,
  ) {
    const siblings = await tx.productCustomField.findMany({
      where: {
        product_id: productId,
        parent_id: parentId,
        id: { not: selfId },
      },
      select: {
        id: true,
        linked_validation: true,
        conditions: true,
        repeat: true,
      },
    });
    for (const sib of siblings) {
      const data: Record<string, Prisma.InputJsonValue> = {};
      const link = sib.linked_validation;
      if (isPlainObject(link)) {
        const target =
          typeof link.target === 'string' ? link.target.trim() : undefined;
        // Legacy rows (pre-K3 dashboard) hold the name in `target_field_id`
        // and may have no `target` at all (M5 A4): honoured and migrated.
        const legacy =
          typeof link.target_field_id === 'string'
            ? link.target_field_id.trim()
            : undefined;
        if (target === oldName || (!target && legacy === oldName)) {
          const { target_field_id: _legacy, ...rest } = link;
          void _legacy;
          data.linked_validation = {
            ...rest,
            target: newName,
          } as Prisma.InputJsonValue;
        }
      }
      if (parentId === null) {
        const refs = renameFieldReferences(
          { conditions: sib.conditions, repeat: sib.repeat },
          oldName,
          newName,
        );
        if (refs.conditions !== undefined) data.conditions = refs.conditions;
        if (refs.repeat !== undefined) data.repeat = refs.repeat;
      }
      if (Object.keys(data).length === 0) continue;
      await tx.productCustomField.update({ where: { id: sib.id }, data });
    }
  }

  /** Field-count caps on create (100 per product, 20 per repeater). */
  private assertFieldLimits(
    rows: readonly { parent_id: string | null }[],
    parentId: string | null,
  ): void {
    if (rows.length >= FIELD_LIMITS.perProduct) {
      throw fieldLimit(FIELD_LIMITS.perProduct);
    }
    if (
      parentId !== null &&
      rows.filter((r) => r.parent_id === parentId).length >=
        FIELD_LIMITS.perRepeater
    ) {
      throw fieldLimit(FIELD_LIMITS.perRepeater);
    }
  }

  /**
   * The personalization settings of the store behind a creator product,
   * with its `url_prefill` map; null for provider products or when the
   * store has no `url_prefill`.
   */
  private async prefillOf(
    db: Db,
    productId: string,
  ): Promise<{
    storeId: string;
    creatorId: string;
    settings: Record<string, unknown>;
    prefill: Record<string, unknown>;
  } | null> {
    const product = await db.product.findUnique({
      where: { id: productId },
      select: { creator_id: true },
    });
    if (!product?.creator_id) return null;
    const store = await db.store.findUnique({
      where: { creator_id: product.creator_id },
      select: { id: true },
    });
    if (!store) return null;
    const row = await db.storeApp.findUnique({
      where: {
        store_id_app_key: { store_id: store.id, app_key: 'personalization' },
      },
      select: { settings: true },
    });
    const settings = row?.settings;
    if (!isPlainObject(settings) || !isPlainObject(settings.url_prefill)) {
      return null;
    }
    return {
      storeId: store.id,
      creatorId: product.creator_id,
      settings,
      prefill: settings.url_prefill,
    };
  }

  /** True when another top-level field of the creator's products is named `name`. */
  private async nameUsedElsewhere(
    db: Db,
    creatorId: string,
    fieldId: string,
    name: string,
  ): Promise<boolean> {
    const other = await db.productCustomField.findFirst({
      where: {
        name,
        parent_id: null,
        id: { not: fieldId },
        product: { creator_id: creatorId },
      },
      select: { id: true },
    });
    return !!other;
  }

  /**
   * Renames the store's `url_prefill` targets that name the field (same
   * transaction), unless another product of the store still has a
   * top-level field with the old name. Returns the store id when the
   * settings changed.
   */
  private async renameUrlPrefill(
    tx: Prisma.TransactionClient,
    productId: string,
    fieldId: string,
    oldName: string,
    newName: string,
  ): Promise<string | null> {
    const found = await this.prefillOf(tx, productId);
    if (!found || !Object.values(found.prefill).includes(oldName)) return null;
    if (await this.nameUsedElsewhere(tx, found.creatorId, fieldId, oldName)) {
      return null;
    }
    const urlPrefill: Record<string, unknown> = {};
    for (const [param, target] of Object.entries(found.prefill)) {
      urlPrefill[param] = target === oldName ? newName : target;
    }
    await tx.storeApp.update({
      where: {
        store_id_app_key: {
          store_id: found.storeId,
          app_key: 'personalization',
        },
      },
      data: {
        settings: {
          ...found.settings,
          url_prefill: urlPrefill,
        } as Prisma.InputJsonObject,
      },
    });
    return found.storeId;
  }

  /**
   * Who still references a field about to be deleted: sibling links, the
   * field-source conditions and repeater lead lists of the other top-level
   * fields, and the store's `url_prefill` (as `url_prefill.<param>`, only
   * when no other product of the store has a top-level field of that name).
   */
  private async referencesTo(db: Db, field: StoredField): Promise<string[]> {
    const rows = await db.productCustomField.findMany({
      where: { product_id: field.product_id },
      select: {
        id: true,
        name: true,
        parent_id: true,
        linked_validation: true,
        conditions: true,
        repeat: true,
      },
    });
    const refs = fieldReferencesTo(
      { id: field.id, name: field.name, parent_id: field.parent_id ?? null },
      rows,
    );
    if ((field.parent_id ?? null) !== null) return refs;
    const found = await this.prefillOf(db, field.product_id);
    if (!found) return refs;
    const params = Object.entries(found.prefill)
      .filter(([, target]) => target === field.name)
      .map(([param]) => `url_prefill.${param}`);
    if (
      params.length > 0 &&
      !(await this.nameUsedElsewhere(db, found.creatorId, field.id, field.name))
    ) {
      refs.push(...params);
    }
    return refs;
  }

  /**
   * Checked JSON columns: only the keys the DTO carried are returned, so an
   * update without them leaves the stored rules alone; `null` clears.
   */
  private sanitizeRules(
    input: {
      options?: unknown;
      validation_rules?: unknown;
      linked_validation?: unknown;
    },
    self: { name?: string | null; id?: string },
  ) {
    const out: {
      options?: Prisma.InputJsonValue | typeof Prisma.DbNull;
      validation_rules?: Prisma.InputJsonValue | typeof Prisma.DbNull;
      linked_validation?: Prisma.InputJsonValue | typeof Prisma.DbNull;
    } = {};
    const options = sanitizeOptions(input.options);
    if (options !== undefined) out.options = options;
    const rules = sanitizeValidationRules(input.validation_rules);
    if (rules !== undefined) out.validation_rules = rules;
    const link = sanitizeLinkedValidation(input.linked_validation, self);
    if (link !== undefined) out.linked_validation = link;
    return out;
  }

  /**
   * Field names are unique per sibling set `(product_id, parent_id, name)`
   * (links resolve by name, K3/C16). Checked here rather than with a unique
   * index because legacy data may already hold duplicates (audit query 1).
   */
  private async assertNameFree(
    db: Db,
    productId: string,
    parentId: string | null,
    name: string | undefined,
    excludeId?: string,
  ) {
    if (!name) return;
    const clash = await db.productCustomField.findFirst({
      where: {
        product_id: productId,
        parent_id: parentId,
        name,
        ...(excludeId ? { id: { not: excludeId } } : {}),
      },
      select: { id: true },
    });
    if (clash) {
      throw new ConflictException({
        code: CUSTOM_FIELD_NAME_TAKEN,
        message: `Another field of this product is already named "${name}"`,
        params: { name },
      });
    }
  }

  async delete(id: string, userId: string, role: UserRole) {
    const field = await this.findFieldOrThrow(id);
    const product = await this.assertCanManage(field.product_id, userId, role);

    // M4.0: order values keep a snapshot and lose the link (SET NULL), and a
    // creator's value for the field is removed with it (CASCADE), so the
    // delete succeeds. A remaining foreign key (defence) becomes a 409.
    // M4.1: a REPEATER's children are deleted with it (CASCADE). A field
    // other fields (or the store's URL prefill) still reference is refused
    // (409 PERSONALIZATION_FIELD_IN_USE): the references would dangle.
    try {
      const deleted = await this.prisma.$transaction(async (tx) => {
        await lockProductFields(tx, field.product_id);
        const refs = await this.referencesTo(tx, field);
        if (refs.length > 0) throw fieldInUse(refs);
        return tx.productCustomField.delete({ where: { id } });
      });
      this.revalidateProduct(product.creator_id);
      return deleted;
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2003'
      ) {
        throw new ConflictException({
          code: CUSTOM_FIELD_IN_USE,
          message: 'This field is still referenced and cannot be deleted',
        });
      }
      throw err;
    }
  }

  async reorder(
    productId: string,
    fieldIds: string[],
    userId: string,
    role: UserRole,
  ) {
    const product = await this.assertCanManage(productId, userId, role);

    const ids = fieldIds || [];
    await this.prisma.$transaction(async (tx) => {
      await lockProductFields(tx, productId);
      // M4.1: field references must still point at earlier fields in the
      // new order (FORWARD_REFERENCE → 400 PERSONALIZATION_CONFIG_INVALID).
      const position = new Map<string, number>();
      ids.forEach((id, index) => position.set(id, index));
      await this.assertOrderReferences(tx, productId, position);

      // Only touch fields that belong to this product: an id from another
      // product must not be re-sorted through this route.
      for (const [index, id] of ids.entries()) {
        await tx.productCustomField.updateMany({
          where: { id, product_id: productId },
          data: { sort_order: index },
        });
      }
    });
    this.revalidateProduct(product.creator_id);

    return this.findByProduct(productId);
  }

  private async findFieldOrThrow(
    id: string,
    db: Db = this.prisma,
  ): Promise<StoredField> {
    const field = await db.productCustomField.findUnique({
      where: { id },
      select: {
        id: true,
        product_id: true,
        name: true,
        type: true,
        parent_id: true,
        sort_order: true,
        options: true,
        validation_rules: true,
        linked_validation: true,
        conditions: true,
        pricing: true,
        repeat: true,
        ui: true,
      },
    });
    if (!field)
      throw new NotFoundException({
        code: 'CUSTOM_FIELD_NOT_FOUND',
        message: 'Custom field not found',
      });
    return field;
  }

  /**
   * Ownership gate for every write. ADMIN always passes; a PROVIDER must own
   * the product through provider.user_id and a CREATOR through
   * creator.user_id. Anything else (other role, foreign product) is refused.
   */
  private async assertCanManage(
    productId: string,
    userId: string,
    role: UserRole,
  ): Promise<{ id: string; creator_id: string | null }> {
    const product = await this.prisma.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        creator_id: true,
        provider: { select: { user_id: true } },
        creator: { select: { user_id: true } },
      },
    });
    if (!product)
      throw new NotFoundException({
        code: 'CUSTOM_FIELD_PRODUCT_NOT_FOUND',
        message: 'Product not found',
      });

    if (role === UserRole.ADMIN) return product;

    const owns =
      (role === UserRole.PROVIDER &&
        !!userId &&
        product.provider?.user_id === userId) ||
      (role === UserRole.CREATOR &&
        !!userId &&
        product.creator?.user_id === userId);

    if (!owns)
      throw new ForbiddenException({
        code: 'CUSTOM_FIELD_FORBIDDEN',
        message: 'Not your product',
      });
    return product;
  }
}
