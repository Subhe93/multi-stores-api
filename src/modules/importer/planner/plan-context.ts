import type { NormalizedCatalog } from '../model/normalized';
import type { MapWarning } from '../mapping/map-product';
import type { ImportRunOptions } from '../runs/run-options';
import type { ImporterHtmlSanitizer } from '../html/html-sanitizer';
import {
  ledgerKey,
  type LedgerRow,
  type TargetSnapshot,
} from './target-snapshot';
import type { PlanInput, PlanItem } from './plan-types';

/**
 * State the per-entity planners share for one `planImport` call: the input,
 * the item list being built (push order = report order) and the collected
 * mapping warnings. Created once by the orchestrator.
 */
export interface PlanContext {
  catalog: NormalizedCatalog;
  catalogHash: string;
  options: ImportRunOptions;
  scopes: ImportRunOptions['scopes'];
  snapshot: TargetSnapshot;
  sanitizer: ImporterHtmlSanitizer;
  now: Date;
  hostAliases: string[] | undefined;
  items: PlanItem[];
  mapWarnings: MapWarning[];
  // Function-typed properties (not methods): the planners destructure them.
  warn: (w: MapWarning) => void;
  /** Ledger row of `(entity_type, external_ref)`. */
  ledger: (type: string, ref: string) => LedgerRow | undefined;
  push: (item: PlanItem) => void;
}

export function createPlanContext(input: PlanInput): PlanContext {
  const items: PlanItem[] = [];
  const mapWarnings: MapWarning[] = [];
  return {
    catalog: input.catalog,
    catalogHash: input.catalogHash,
    options: input.options,
    scopes: input.options.scopes,
    snapshot: input.snapshot,
    sanitizer: input.sanitizer,
    now: input.now,
    hostAliases: input.hostAliases,
    items,
    mapWarnings,
    warn: (w) => {
      mapWarnings.push(w);
    },
    ledger: (type, ref) => input.snapshot.ledger.get(ledgerKey(type, ref)),
    push: (item) => {
      items.push(item);
    },
  };
}
