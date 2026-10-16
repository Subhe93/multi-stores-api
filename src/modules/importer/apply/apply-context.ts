import {
  ImportEntityStatus,
  ImportItemAction,
  ImportItemPhase,
  ImportLogLevel,
  Prisma,
  type PrismaClient,
} from '@prisma/client';
import type { DesignerImportPort } from '../../../common/ports/designer-import.port';
import type { RedirectsService } from '../../redirects/redirects.service';
import type { ImportRunOptions } from '../runs/run-options';
import type { PersonalizationPresetPort } from '../ports/personalization.port';
import type { StoredMedia } from '../media/media-importer';

/** Everything the phase writers need (one run). */
export interface ApplyContext {
  prisma: PrismaClient;
  storeId: string;
  creatorId: string;
  runId: string;
  primaryLocale: string;
  siteHost: string;
  options: ImportRunOptions;
  personalization: PersonalizationPresetPort;
  designer: DesignerImportPort;
  redirects: Pick<RedirectsService, 'bulkUpsertFromImport' | 'invalidate'>;
  personalizationAvailable: boolean;
  designerAvailable: boolean;
  creatorHasDefaultProfile: boolean;
  /** Stored media by source URL (filled by the media phase / ledger). */
  media: Map<string, StoredMedia>;
  log: (
    level: ImportLogLevel,
    code: string,
    message: string,
    extra?: {
      entity_type?: string;
      external_ref?: string;
      data?: Record<string, unknown>;
    },
  ) => Promise<void>;
  /** Called between batches: throws when the run must stop (cancel, timeout). */
  checkpoint: () => Promise<void>;
}

export type Tx = Prisma.TransactionClient;

export interface ApplyItem {
  entity_type: string;
  external_ref: string;
  action: ImportItemAction;
  target_id?: string | null;
  before?: Prisma.InputJsonValue | null;
  diff?: Prisma.InputJsonValue | null;
  message?: string | null;
  /** Report label, stored as `diff.title` (the item table has no title column). */
  title?: string | null;
}

export const PRODUCT_TX_TIMEOUT_MS = 30_000;

/** Public URL of an imported media, or null when it was not stored. */
export function publicUrlOf(
  ctx: ApplyContext,
  sourceUrl: string | null | undefined,
): string | null {
  if (!sourceUrl) return null;
  return ctx.media.get(sourceUrl)?.public_url ?? null;
}

export async function recordItems(
  db: Tx,
  runId: string,
  phase: ImportItemPhase,
  items: ApplyItem[],
): Promise<void> {
  if (!items.length) return;
  await db.importRunItem.createMany({
    data: items.map((i) => ({
      run_id: runId,
      phase,
      entity_type: i.entity_type.slice(0, 32),
      external_ref: i.external_ref.slice(0, 255),
      action: i.action,
      target_id: i.target_id ?? null,
      ...(i.before != null ? { before: i.before } : {}),
      ...(i.diff != null
        ? { diff: i.diff }
        : i.title
          ? { diff: { title: i.title.slice(0, 300) } }
          : {}),
      message: i.message ?? null,
    })),
  });
}

/** External refs (of one type) that already have an APPLY item in this run — resume without duplicates. */
export async function appliedRefs(
  db: Tx,
  runId: string,
  entityType: string,
  refs: string[],
): Promise<Set<string>> {
  if (!refs.length) return new Set();
  const rows = await db.importRunItem.findMany({
    where: {
      run_id: runId,
      phase: ImportItemPhase.APPLY,
      entity_type: entityType,
      external_ref: { in: refs.map((r) => r.slice(0, 255)) },
    },
    select: { external_ref: true },
  });
  return new Set(rows.map((r) => r.external_ref));
}

export interface LedgerWrite {
  entity_type: string;
  external_ref: string;
  target_id: string | null;
  source_hash: string;
  applied_hash?: string | null;
  /** CREATE (this run made it) resets `first_run_id` and `created_by_import`. */
  created: boolean;
  created_by_import?: boolean;
  status?: ImportEntityStatus;
  payload?: Prisma.InputJsonValue | null;
}

/** The ledger row as it was before this run wrote it (restored by rollback, fix 6). */
export interface LedgerBefore {
  source_hash: string;
  applied_hash: string | null;
  status: ImportEntityStatus;
  created_by_import: boolean;
  first_run_id: string;
  last_run_id: string;
  target_id: string | null;
}

export async function ledgerBefore(
  db: Tx,
  ctx: Pick<ApplyContext, 'storeId'>,
  entityType: string,
  ref: string,
): Promise<LedgerBefore | null> {
  const row = await db.importEntity.findUnique({
    where: {
      store_id_entity_type_external_ref: {
        store_id: ctx.storeId,
        entity_type: entityType,
        external_ref: ref,
      },
    },
    select: {
      source_hash: true,
      applied_hash: true,
      status: true,
      created_by_import: true,
      first_run_id: true,
      last_run_id: true,
      target_id: true,
    },
  });
  return row ?? null;
}

export async function upsertLedger(
  db: Tx,
  ctx: Pick<ApplyContext, 'storeId' | 'runId'>,
  w: LedgerWrite,
): Promise<void> {
  const status = w.status ?? ImportEntityStatus.ACTIVE;
  // `null` clears the payload (e.g. a product that is complete again).
  const payload =
    w.payload === undefined
      ? undefined
      : w.payload === null
        ? Prisma.DbNull
        : w.payload;
  await db.importEntity.upsert({
    where: {
      store_id_entity_type_external_ref: {
        store_id: ctx.storeId,
        entity_type: w.entity_type,
        external_ref: w.external_ref,
      },
    },
    create: {
      store_id: ctx.storeId,
      entity_type: w.entity_type,
      external_ref: w.external_ref,
      target_id: w.target_id,
      source_hash: w.source_hash,
      applied_hash: w.applied_hash ?? null,
      created_by_import: w.created ? true : (w.created_by_import ?? false),
      status,
      ...(payload !== undefined && payload !== Prisma.DbNull
        ? { payload }
        : {}),
      first_run_id: ctx.runId,
      last_run_id: ctx.runId,
    },
    update: {
      target_id: w.target_id,
      source_hash: w.source_hash,
      applied_hash: w.applied_hash ?? null,
      status,
      ...(payload !== undefined ? { payload } : {}),
      last_run_id: ctx.runId,
      ...(w.created
        ? { first_run_id: ctx.runId, created_by_import: true }
        : {}),
      ...(!w.created && w.created_by_import !== undefined
        ? { created_by_import: w.created_by_import }
        : {}),
    },
  });
}

export function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}
