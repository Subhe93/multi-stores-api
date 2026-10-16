import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { readOptionNames } from './personalization-config.validator';
import {
  createFieldTree,
  type CreatedField,
  type FieldWriteActor,
  loadFieldSiblings,
  lockProductForWrite,
  nextTopSortOrder,
} from './personalization-field-writer';
import {
  presetConflict,
  presetParamsInvalid,
  presetUnknown,
} from './personalization.errors';
import {
  findPreset,
  presetSummaries,
  resolvePresetParams,
  type PresetSummary,
} from './presets';

export const PRESET_MODES = [
  'append',
  'replace_preset',
  'skip_if_exists',
] as const;
export type PresetMode = (typeof PRESET_MODES)[number];

export interface ApplyPresetOptions {
  /** Default `append`. */
  mode?: PresetMode;
  /** Importer external ref (M4.4), stored as `preset_ref` (≤ 191). */
  source_ref?: string | null;
}

export interface ApplyPresetResult {
  /** Created top-level fields, children nested. */
  fields: CreatedField[];
  /** Draft names skipped by `skip_if_exists`. */
  skipped: string[];
  /** Top-level fields removed by `replace_preset`. */
  replaced: number;
}

/**
 * Applies code presets (M4.1 §4.6, D12) to a product. `apply` runs one
 * transaction around `applyInTx`, which the M4.4 importer calls inside its
 * own per-product transaction (C25).
 */
@Injectable()
export class PersonalizationPresetsService {
  constructor(private readonly prisma: PrismaService) {}

  list(): PresetSummary[] {
    return presetSummaries();
  }

  async apply(
    productId: string,
    key: string,
    params: unknown,
    opts: ApplyPresetOptions,
    actor: FieldWriteActor,
  ): Promise<ApplyPresetResult> {
    if (!findPreset(key)) throw presetUnknown(key);
    return this.prisma.$transaction(
      (tx) => this.applyInTx(tx, productId, key, params, opts, actor),
      { timeout: 20_000 },
    );
  }

  /**
   * Modes:
   * - `append`: every preset field is created; a name already used at the
   *   top level → 409 PERSONALIZATION_PRESET_CONFLICT (nothing written).
   * - `skip_if_exists`: drafts whose name exists are skipped (idempotent).
   * - `replace_preset`: the product's top-level fields with this preset_key
   *   (and their children) are deleted first (orders keep their snapshot,
   *   SetNull), then the preset is created; another field with a preset
   *   name → 409.
   */
  async applyInTx(
    tx: Prisma.TransactionClient,
    productId: string,
    key: string,
    params: unknown,
    opts: ApplyPresetOptions,
    actor: FieldWriteActor,
  ): Promise<ApplyPresetResult> {
    const preset = findPreset(key);
    if (!preset) throw presetUnknown(key);
    const mode = opts.mode ?? 'append';
    if (!(PRESET_MODES as readonly string[]).includes(mode)) {
      throw new BadRequestException({
        code: 'VALIDATION_ERROR',
        message: `mode must be one of: ${PRESET_MODES.join(', ')}`,
      });
    }
    const sourceRef =
      typeof opts.source_ref === 'string' && opts.source_ref !== ''
        ? opts.source_ref.slice(0, 191)
        : null;

    const product = await lockProductForWrite(tx, productId, actor);
    const resolved = resolvePresetParams(
      preset,
      params,
      readOptionNames(product.optionConfig),
    );
    if (resolved.errors.length > 0) throw presetParamsInvalid(resolved.errors);

    let existing = await loadFieldSiblings(tx, productId);
    let replaced = 0;
    if (mode === 'replace_preset') {
      const ids = existing
        .filter((f) => !f.parent_id && f.preset_key === key)
        .map((f) => f.id);
      if (ids.length > 0) {
        // Children go with their parent (FK cascade).
        await tx.productCustomField.deleteMany({ where: { id: { in: ids } } });
        const gone = new Set(ids);
        existing = existing.filter(
          (f) => !gone.has(f.id) && !(f.parent_id && gone.has(f.parent_id)),
        );
        replaced = ids.length;
      }
    }

    const existingNames = new Set(
      existing.filter((f) => !f.parent_id).map((f) => f.name),
    );
    const drafts = preset.build(resolved.params, {
      existingNames,
      primaryLocale: product.primaryLocale,
    });
    const clashes = drafts
      .map((d) => d.name)
      .filter((n) => existingNames.has(n));
    if (clashes.length > 0 && mode !== 'skip_if_exists') {
      throw presetConflict(clashes);
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
    const fields: CreatedField[] = [];
    for (const draft of drafts) {
      if (existingNames.has(draft.name)) continue;
      fields.push(
        await createFieldTree(tx, ctx, draft, {
          preset_key: draft.preset_key ?? key,
          preset_ref: sourceRef,
        }),
      );
    }
    return { fields, skipped: clashes, replaced };
  }
}
