import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { StoreAppsService } from '../../store-apps/store-apps.service';
import { PersonalizationPresetsService } from '../../personalization/personalization-presets.service';
import type { PresetKey } from '../model/presets';

/**
 * Importer → personalization app (M4.1) hand-off — M4-INTEGRATION C25,
 * M4.4 §8.1. A thin adapter over `PersonalizationPresetsService.applyInTx`
 * inside the importer's per-product transaction. No Null implementation:
 * M4.1 ships before M4.4. Modes: CREATE → `skip_if_exists`, UPDATE →
 * `replace_preset` (fields deleted by a replace keep their order snapshots,
 * M4.0 SetNull).
 */

export const PERSONALIZATION_PRESET_PORT = Symbol(
  'PERSONALIZATION_PRESET_PORT',
);

export interface PresetRequest {
  key: PresetKey;
  params: Record<string, unknown>;
  /** `woo:<host>:product:<id>#<mechanism>` → `ProductCustomField.preset_ref`. */
  source_ref: string;
  mode: 'skip_if_exists' | 'replace_preset';
}

export interface PresetApplyResult {
  source_ref: string;
  field_ids: string[];
  skipped: string[];
  replaced: number;
}

export interface PersonalizationPresetPort {
  isAvailable(storeId: string): Promise<boolean>;
  applyPresets(
    tx: Prisma.TransactionClient,
    productId: string,
    reqs: PresetRequest[],
  ): Promise<PresetApplyResult[]>;
}

function collectIds(fields: { id: string; children?: unknown }[]): string[] {
  const out: string[] = [];
  for (const f of fields) {
    out.push(f.id);
    if (Array.isArray(f.children))
      out.push(...collectIds(f.children as { id: string }[]));
  }
  return out;
}

@Injectable()
export class PersonalizationPresetPortAdapter implements PersonalizationPresetPort {
  constructor(
    private readonly presets: PersonalizationPresetsService,
    private readonly storeApps: StoreAppsService,
  ) {}

  isAvailable(storeId: string): Promise<boolean> {
    return this.storeApps.isEnabled(storeId, 'personalization');
  }

  async applyPresets(
    tx: Prisma.TransactionClient,
    productId: string,
    reqs: PresetRequest[],
  ): Promise<PresetApplyResult[]> {
    const out: PresetApplyResult[] = [];
    for (const r of reqs) {
      const res = await this.presets.applyInTx(
        tx,
        productId,
        r.key,
        r.params,
        { mode: r.mode, source_ref: r.source_ref },
        'system',
      );
      out.push({
        source_ref: r.source_ref,
        field_ids: collectIds(
          res.fields as unknown as { id: string; children?: unknown }[],
        ),
        skipped: res.skipped,
        replaced: res.replaced,
      });
    }
    return out;
  }
}
