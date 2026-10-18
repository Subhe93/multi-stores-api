import { Inject, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Readable } from 'stream';
import {
  ImportItemPhase,
  ImportRunStatus,
  Prisma,
  type ImportRun,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  PRIVATE_STORAGE,
  type PrivateStorage,
} from '../../../common/storage/private-file-storage';
import {
  importError,
  importErrorFromRun,
  ImportRunError,
  isUniqueViolation,
} from '../importer.errors';
import { ImportSourcesService } from '../sources/import-sources.service';
import { ImportEngineService } from './import-engine.service';
import type { ImportPlan } from '../planner/planner';
import { normalizeRunOptions } from './run-options';
import {
  ACTIVE_RUN_STATUSES,
  DIRECT_CANCEL_STATUSES,
  REQUEST_CANCEL_STATUSES,
  ROLLBACKABLE_STATUSES,
  canTransition,
} from './run-state';
import {
  BUNDLE_DIR_MAX_BYTES,
  deleteBundle,
  BUNDLE_DIR_MAX_FILE_BYTES,
  readBundleDirectory,
  storeBundleFiles,
  validateBundleFiles,
  type BundleLimits,
  type UploadedBundleFile,
} from './bundle-store';
import type {
  RunItemsQueryDto,
  RunListQueryDto,
  RunLogsQueryDto,
} from '../dto/run.dto';

/** Run view for the dashboard (no storage keys). */
export interface ImportRunView {
  id: string;
  source_id: string;
  status: ImportRunStatus;
  options: unknown;
  plan_fingerprint: string | null;
  summary: unknown;
  progress: unknown;
  error: string | null;
  attempt: number;
  bundle_sha256: string | null;
  bundle_bytes: number | null;
  cancel_requested: boolean;
  cancel_requested_at: Date | null;
  source?: { name: string; kind: string; site_host: string };
  created_by: string | null;
  /** Owner's email when the store owner created the run; never an admin's (fix 23). */
  created_by_name?: string | null;
  /** `OWNER` or `ADMIN` (anyone who is not the store owner); dashboard translates it. */
  created_by_role?: 'OWNER' | 'ADMIN' | null;
  /** Runs list (fix 24): entity → action → n for PRODUCT / CATEGORY / REDIRECT. */
  counts?: Record<string, Record<string, number>> | null;
  /** Which phase `counts` comes from. */
  counts_phase?: 'APPLY' | 'PLAN' | null;
  confirmed_by: string | null;
  rollback_by: string | null;
  planned_at: Date | null;
  started_at: Date | null;
  finished_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export function toRunView(r: ImportRun, withSummary = true): ImportRunView {
  return {
    id: r.id,
    source_id: r.source_id,
    status: r.status,
    options: r.options,
    plan_fingerprint: r.plan_fingerprint,
    summary: withSummary ? r.summary : undefined,
    progress: r.progress,
    error: r.error,
    attempt: r.attempt,
    bundle_sha256: r.bundle_sha256,
    bundle_bytes: r.bundle_bytes,
    cancel_requested: !!r.cancel_requested_at,
    cancel_requested_at: r.cancel_requested_at,
    created_by: r.created_by,
    confirmed_by: r.confirmed_by,
    rollback_by: r.rollback_by,
    planned_at: r.planned_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

const LIST_COUNT_TYPES = ['PRODUCT', 'CATEGORY', 'REDIRECT'] as const;

/** Rows per page of the streamed CSV report (M5 B14). */
export const REPORT_CSV_PAGE = 1000;

/** Small per-run counts for the runs list (fix 24): apply counts, else plan counts. */
export function listCounts(
  r: ImportRun,
): Pick<ImportRunView, 'counts' | 'counts_phase'> {
  const s = (r.summary ?? null) as {
    counts?: Record<string, Record<string, number>>;
    apply?: { counts?: Record<string, Record<string, number>> };
  } | null;
  const src = s?.apply?.counts ?? s?.counts ?? null;
  if (!src) return { counts: null, counts_phase: null };
  const counts: Record<string, Record<string, number>> = {};
  for (const t of LIST_COUNT_TYPES) if (src[t]) counts[t] = { ...src[t] };
  return { counts, counts_phase: s?.apply?.counts ? 'APPLY' : 'PLAN' };
}

function busy() {
  return importError(
    'IMPORT_RUN_BUSY',
    'Another import run of this store is in progress',
  );
}

function invalidState(r: ImportRun, action: string) {
  return importError(
    'IMPORT_RUN_INVALID_STATE',
    `Cannot ${action} a run in status ${r.status}`,
    {
      status: r.status,
    },
  );
}

function csvCell(v: unknown): string {
  const s =
    v === null || v === undefined
      ? ''
      : typeof v === 'string'
        ? v
        : JSON.stringify(v);
  // Spreadsheet formula injection guard.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r;]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** HTTP-facing run operations (M4.4 §10). Every lookup is scoped to the caller's store. */
@Injectable()
export class ImportRunsService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PRIVATE_STORAGE) private readonly storage: PrivateStorage,
    private readonly sources: ImportSourcesService,
    private readonly engine: ImportEngineService,
  ) {}

  /** Store of the authenticated creator (404 STORE_NOT_FOUND). */
  async storeIdForCreator(userId: string): Promise<string> {
    const creator = await this.prisma.creator.findUnique({
      where: { user_id: userId },
      select: { store: { select: { id: true } } },
    });
    const id = creator?.store?.id;
    if (!id)
      throw new NotFoundException({
        code: 'STORE_NOT_FOUND',
        message: 'Store not found',
      });
    return id;
  }

  async get(storeId: string, id: string): Promise<ImportRun> {
    const run = await this.prisma.importRun.findFirst({
      where: { id, store_id: storeId },
    });
    if (!run) throw importError('IMPORT_RUN_NOT_FOUND', 'Import run not found');
    return run;
  }

  private async assertNoActiveRun(storeId: string): Promise<void> {
    const n = await this.prisma.importRun.count({
      where: { store_id: storeId, status: { in: [...ACTIVE_RUN_STATUSES] } },
    });
    if (n > 0) throw busy();
  }

  /** `POST runs`: stores the uploaded bundle files and queues the dry run (UPLOADED). */
  async create(
    storeId: string,
    userId: string,
    sourceId: string,
    raw: unknown,
    files: UploadedBundleFile[],
    limits: BundleLimits = {},
  ): Promise<ImportRunView> {
    const source = await this.sources.get(storeId, sourceId);
    if (source.kind !== 'WP_BUNDLE') {
      throw importError(
        'IMPORT_SOURCE_KIND_UNSUPPORTED',
        'Only WordPress export bundles can be imported in this version',
      );
    }
    const { options, errors } = normalizeRunOptions(raw);
    if (errors.length)
      throw importError('IMPORT_RUN_OPTIONS_INVALID', errors[0], { errors });
    // An uploaded archive is expanded here; everything below sees plain files.
    files = await validateBundleFiles(files, limits);
    await this.assertNoActiveRun(storeId);

    const runId = randomUUID();
    const stored = await storeBundleFiles(this.storage, storeId, runId, files);
    try {
      const run = await this.prisma.importRun.create({
        data: {
          id: runId,
          store_id: storeId,
          source_id: source.id,
          status: ImportRunStatus.UPLOADED,
          bundle_key: stored.bundle_key,
          bundle_sha256: stored.bundle_sha256,
          bundle_bytes: stored.bundle_bytes,
          options: options as unknown as Prisma.InputJsonValue,
          created_by: userId,
          progress: {
            phase: 'uploaded',
            done: 0,
            total: 0,
            files: stored.files,
          } as Prisma.InputJsonValue,
        },
      });
      return toRunView(run);
    } catch (e) {
      await deleteBundle(this.storage, stored.bundle_key);
      if (isUniqueViolation(e)) throw busy();
      throw e;
    }
  }

  /** Parses the multipart `options` field (a JSON string). */
  static parseOptionsField(json: string | undefined): unknown {
    if (!json) return undefined;
    try {
      return JSON.parse(json);
    } catch {
      throw importError(
        'IMPORT_RUN_OPTIONS_INVALID',
        'options must be valid JSON',
      );
    }
  }

  /**
   * Admin / server-side run (e.g. the Namez run): reads an extracted bundle
   * directory (or one `.tgz` / `.zip`) below `IMPORTER_BUNDLE_DIR_ROOT`
   * (unset = disabled) and creates the run exactly like an upload.
   */
  async createFromDirectory(
    storeId: string,
    userId: string,
    sourceId: string,
    directory: string,
    raw: unknown,
  ): Promise<ImportRunView> {
    const files = await readBundleDirectory(directory);
    return this.create(storeId, userId, sourceId, raw, files, {
      maxTotalBytes: BUNDLE_DIR_MAX_BYTES,
      maxFileBytes: BUNDLE_DIR_MAX_FILE_BYTES,
    });
  }

  async list(storeId: string, q: RunListQueryDto) {
    const page = q.page ?? 1;
    const limit = q.limit ?? 20;
    const where: Prisma.ImportRunWhereInput = {
      store_id: storeId,
      ...(q.status ? { status: q.status } : {}),
      ...(q.source_id ? { source_id: q.source_id } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.importRun.count({ where }),
      this.prisma.importRun.findMany({
        where,
        orderBy: [{ created_at: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    const views = await this.decorate(rows.map((r) => toRunView(r, false)));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return {
      items: views.map((v) => ({ ...v, ...listCounts(byId.get(v.id)!) })),
      total,
      page,
      limit,
    };
  }

  /** Adds `source{name}`, `created_by_name` and `created_by_role` for the dashboard. */
  private async decorate(views: ImportRunView[]): Promise<ImportRunView[]> {
    if (!views.length) return views;
    const sourceIds = [...new Set(views.map((v) => v.source_id))];
    const userIds = [
      ...new Set(
        views.map((v) => v.created_by).filter((u): u is string => !!u),
      ),
    ];
    // Store owner per run (runs of one call share a store in practice).
    const runs = await this.prisma.importRun.findMany({
      where: { id: { in: views.map((v) => v.id) } },
      select: { id: true, store_id: true },
    });
    const storeOf = new Map(runs.map((r) => [r.id, r.store_id]));
    const stores = await this.prisma.store.findMany({
      where: { id: { in: [...new Set(runs.map((r) => r.store_id))] } },
      select: { id: true, creator_id: true },
    });
    const creators = await this.prisma.creator.findMany({
      where: { id: { in: stores.map((s) => s.creator_id) } },
      select: { id: true, user_id: true },
    });
    const ownerOfCreator = new Map(creators.map((c) => [c.id, c.user_id]));
    const ownerOfStore = new Map(
      stores.map((s) => [s.id, ownerOfCreator.get(s.creator_id) ?? null]),
    );
    const [sources, users] = await Promise.all([
      this.prisma.importSource.findMany({
        where: { id: { in: sourceIds } },
        select: { id: true, name: true, kind: true, site_host: true },
      }),
      userIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: userIds } },
            select: { id: true, email: true },
          })
        : Promise.resolve([] as { id: string; email: string }[]),
    ]);
    const src = new Map(sources.map((s) => [s.id, s]));
    const usr = new Map(users.map((u) => [u.id, u]));
    return views.map((v) => {
      const s = src.get(v.source_id);
      const owner = ownerOfStore.get(storeOf.get(v.id) ?? '') ?? null;
      const isOwner = !!v.created_by && v.created_by === owner;
      const u = isOwner && v.created_by ? usr.get(v.created_by) : undefined;
      return {
        ...v,
        ...(s
          ? { source: { name: s.name, kind: s.kind, site_host: s.site_host } }
          : {}),
        // Never the email of someone who is not the owner (platform admin).
        created_by_name: u ? u.email : null,
        created_by_role: v.created_by ? (isOwner ? 'OWNER' : 'ADMIN') : null,
      };
    });
  }

  async detail(storeId: string, id: string): Promise<ImportRunView> {
    return (await this.decorate([toRunView(await this.get(storeId, id))]))[0];
  }

  async items(storeId: string, id: string, q: RunItemsQueryDto) {
    await this.get(storeId, id);
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const where: Prisma.ImportRunItemWhereInput = {
      run_id: id,
      ...(q.phase ? { phase: q.phase } : {}),
      ...(q.entity_type ? { entity_type: q.entity_type } : {}),
      ...(q.action ? { action: q.action } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.importRunItem.count({ where }),
      this.prisma.importRunItem.findMany({
        where,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    // Every item carries a `title` (stored as diff.title; APPLY/ROLLBACK items borrow the PLAN title).
    const titleOf = (d: unknown): string | null =>
      d &&
      typeof d === 'object' &&
      typeof (d as { title?: unknown }).title === 'string'
        ? (d as { title: string }).title
        : null;
    const missing = rows
      .filter((r) => !titleOf(r.diff))
      .map((r) => r.external_ref);
    const planTitles = new Map<string, string>();
    if (missing.length) {
      const plan = await this.prisma.importRunItem.findMany({
        where: {
          run_id: id,
          phase: ImportItemPhase.PLAN,
          external_ref: { in: [...new Set(missing)] },
        },
        select: { entity_type: true, external_ref: true, diff: true },
      });
      for (const p of plan) {
        const t = titleOf(p.diff);
        if (t) planTitles.set(`${p.entity_type}|${p.external_ref}`, t);
      }
    }
    const items = rows.map((r) => ({
      ...r,
      title:
        titleOf(r.diff) ??
        planTitles.get(`${r.entity_type}|${r.external_ref}`) ??
        null,
    }));
    return { items, total, page, limit };
  }

  async logs(storeId: string, id: string, q: RunLogsQueryDto) {
    await this.get(storeId, id);
    const page = q.page ?? 1;
    const limit = q.limit ?? 50;
    const where: Prisma.ImportRunLogWhereInput = {
      run_id: id,
      ...(q.level ? { level: q.level } : {}),
      ...(q.code ? { code: q.code } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.importRunLog.count({ where }),
      this.prisma.importRunLog.findMany({
        where,
        orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);
    return { items: rows, total, page, limit };
  }

  /**
   * CSV of the items of one phase (default: APPLY when the run applied, else
   * PLAN), streamed in pages of REPORT_CSV_PAGE rows (M5 B14): the response
   * never holds the whole report. Starts with a BOM for spreadsheets.
   */
  async reportCsvStream(
    storeId: string,
    id: string,
    phase?: ImportItemPhase,
  ): Promise<Readable> {
    const run = await this.get(storeId, id);
    const ph =
      phase ?? (run.started_at ? ImportItemPhase.APPLY : ImportItemPhase.PLAN);
    const prisma = this.prisma;
    async function* lines(): AsyncGenerator<string> {
      yield '﻿' +
        [
          'phase',
          'entity_type',
          'external_ref',
          'action',
          'target_id',
          'message',
        ].join(',') +
        '\n';
      for (let skip = 0; ; skip += REPORT_CSV_PAGE) {
        const rows = await prisma.importRunItem.findMany({
          where: { run_id: run.id, phase: ph },
          orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
          skip,
          take: REPORT_CSV_PAGE,
          select: {
            phase: true,
            entity_type: true,
            external_ref: true,
            action: true,
            target_id: true,
            message: true,
          },
        });
        if (!rows.length) return;
        yield rows
          .map(
            (r) =>
              [
                r.phase,
                r.entity_type,
                r.external_ref,
                r.action,
                r.target_id,
                r.message,
              ]
                .map(csvCell)
                .join(',') + '\n',
          )
          .join('');
        if (rows.length < REPORT_CSV_PAGE) return;
      }
    }
    return Readable.from(lines(), { encoding: 'utf8' });
  }

  /** The whole report as one string (tests, small runs); `reportCsvStream` is the HTTP path. */
  async reportCsv(
    storeId: string,
    id: string,
    phase?: ImportItemPhase,
  ): Promise<string> {
    const stream = await this.reportCsvStream(storeId, id, phase);
    let out = '';
    for await (const chunk of stream) out += String(chunk);
    return out.startsWith('﻿') ? out.slice(1) : out;
  }

  /** Mapping-review edits: PLANNED / PLAN_FAILED → UPLOADED (re-plan). */
  async updateOptions(
    storeId: string,
    id: string,
    input: Record<string, unknown>,
  ): Promise<ImportRunView> {
    const run = await this.get(storeId, id);
    if (
      run.status !== ImportRunStatus.PLANNED &&
      run.status !== ImportRunStatus.PLAN_FAILED
    ) {
      throw invalidState(run, 'edit the options of');
    }
    const { options, errors } = normalizeRunOptions(input);
    if (errors.length)
      throw importError('IMPORT_RUN_OPTIONS_INVALID', errors[0], { errors });
    const res = await this.prisma.importRun.updateMany({
      where: { id: run.id, status: run.status },
      data: {
        status: ImportRunStatus.UPLOADED,
        options: options as unknown as Prisma.InputJsonValue,
        plan_fingerprint: null,
        error: null,
        finished_at: null,
        cancel_requested_at: null,
        attempt: 0,
      },
    });
    if (res.count !== 1) throw invalidState(run, 'edit the options of');
    await this.prisma.importRunItem.deleteMany({
      where: { run_id: run.id, phase: ImportItemPhase.PLAN },
    });
    return toRunView(await this.get(storeId, id));
  }

  /** PLANNED → QUEUED after re-checking the plan (409 IMPORT_PLAN_STALE / IMPORT_RUN_BUSY). */
  async confirm(
    storeId: string,
    userId: string,
    id: string,
    fingerprint: string,
  ): Promise<ImportRunView> {
    const run = await this.get(storeId, id);
    if (run.status !== ImportRunStatus.PLANNED)
      throw invalidState(run, 'confirm');
    if (run.plan_fingerprint !== fingerprint) {
      throw importError(
        'IMPORT_PLAN_STALE',
        'The dry run changed; review the new report',
        {
          plan_fingerprint: run.plan_fingerprint,
        },
      );
    }
    let plan: ImportPlan;
    try {
      plan = await this.engine.replanForConfirm(run);
    } catch (e) {
      if (e instanceof ImportRunError) throw importErrorFromRun(e);
      throw e;
    }
    if (plan.blockers.length) {
      throw importError(plan.blockers[0].code, plan.blockers[0].message, {
        blockers: plan.blockers,
      });
    }
    if (plan.fingerprint !== run.plan_fingerprint) {
      throw importError(
        'IMPORT_PLAN_STALE',
        'The store changed since the dry run; run a new dry run',
        {
          plan_fingerprint: plan.fingerprint,
        },
      );
    }
    await this.assertNoActiveRun(storeId);
    try {
      const res = await this.prisma.importRun.updateMany({
        where: {
          id: run.id,
          status: ImportRunStatus.PLANNED,
          plan_fingerprint: fingerprint,
        },
        data: {
          status: ImportRunStatus.QUEUED,
          confirmed_by: userId,
          progress: Prisma.DbNull,
          attempt: 0,
          // A cancel requested during planning must not cancel the confirmed run.
          cancel_requested_at: null,
        },
      });
      if (res.count !== 1) throw invalidState(run, 'confirm');
    } catch (e) {
      if (isUniqueViolation(e)) throw busy();
      throw e;
    }
    return toRunView(await this.get(storeId, id));
  }

  /** Cancel: directly when nothing is running, else a request honoured between batches. */
  async cancel(storeId: string, id: string): Promise<ImportRunView> {
    const run = await this.get(storeId, id);
    if (DIRECT_CANCEL_STATUSES.includes(run.status)) {
      const res = await this.prisma.importRun.updateMany({
        where: { id: run.id, status: run.status },
        data: { status: ImportRunStatus.CANCELLED, finished_at: new Date() },
      });
      if (res.count !== 1) throw invalidState(run, 'cancel');
    } else if (REQUEST_CANCEL_STATUSES.includes(run.status)) {
      await this.prisma.importRun.update({
        where: { id: run.id },
        data: { cancel_requested_at: new Date() },
      });
    } else {
      throw invalidState(run, 'cancel');
    }
    return toRunView(await this.get(storeId, id));
  }

  /**
   * Completed / failed / cancelled runs → ROLLBACK_QUEUED. M5 B12: refused
   * while a later run of the store has applied and was not rolled back
   * (its writes sit on top of this run's; roll that one back first).
   */
  async rollback(
    storeId: string,
    userId: string,
    id: string,
  ): Promise<ImportRunView> {
    const run = await this.get(storeId, id);
    if (!ROLLBACKABLE_STATUSES.includes(run.status) || !run.started_at)
      throw invalidState(run, 'roll back');
    if (!canTransition(run.status, ImportRunStatus.ROLLBACK_QUEUED))
      throw invalidState(run, 'roll back');
    const later = await this.prisma.importRun.findFirst({
      where: {
        store_id: storeId,
        id: { not: run.id },
        started_at: { gt: run.started_at },
        status: {
          in: [
            ImportRunStatus.COMPLETED,
            ImportRunStatus.COMPLETED_WITH_WARNINGS,
          ],
        },
      },
      orderBy: { started_at: 'desc' },
      select: { id: true, started_at: true },
    });
    if (later) {
      throw importError(
        'IMPORT_RUN_INVALID_STATE',
        `A later run (${later.id}) applied after this one; roll it back first`,
        { status: run.status, later_run_id: later.id },
      );
    }
    await this.assertNoActiveRun(storeId);
    try {
      const res = await this.prisma.importRun.updateMany({
        where: { id: run.id, status: run.status },
        data: {
          status: ImportRunStatus.ROLLBACK_QUEUED,
          rollback_by: userId,
          cancel_requested_at: null,
          finished_at: null,
          attempt: 0,
        },
      });
      if (res.count !== 1) throw invalidState(run, 'roll back');
    } catch (e) {
      if (isUniqueViolation(e)) throw busy();
      throw e;
    }
    return toRunView(await this.get(storeId, id));
  }

  /** Not while active: removes the files and the run rows; the ledger stays. */
  async remove(storeId: string, id: string): Promise<{ deleted: true }> {
    const run = await this.get(storeId, id);
    if (ACTIVE_RUN_STATUSES.includes(run.status))
      throw invalidState(run, 'delete');
    if (run.bundle_key) await deleteBundle(this.storage, run.bundle_key);
    if (run.snapshot_key)
      await this.storage.delete(run.snapshot_key).catch(() => false);
    await this.prisma.importRun.delete({ where: { id: run.id } });
    return { deleted: true };
  }
}
