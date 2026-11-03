/**
 * One-time data normalisation (plans/s3-storage/SPEC.md "Database rows keep
 * their current values"): ABSOLUTE public upload URLs of OUR API hosts
 * (`https://<host>/uploads/<folder>/<file>`) become RELATIVE
 * (`/uploads/<folder>/<file>`) in every column / JSON blob of
 * INVENTORY.md §2 (table in `uploads-url-normalize.planner.ts`).
 *
 *   - url columns: rewritten only when the WHOLE value is such a URL, so the
 *     free-text `value` columns of custom field values are safe
 *   - json columns: deep walk; whole-string and embedded (`src="..."`,
 *     `url(...)`) occurrences are rewritten, key order preserved
 *   - URLs of hosts not listed are reported and left alone
 *
 * Modes:
 *   --dry-run (default)       masked per-column report + fingerprint; no writes
 *   --apply --fingerprint=<hash>
 *                             re-plan inside ONE transaction, abort when the
 *                             fingerprint differs, then update row by row
 *   --hosts=a.com,b.com       hosts treated as ours (always also localhost:3001,
 *                             PUBLIC_API_URL and API_PUBLIC_ORIGINS from .env)
 *   --only=model.column,...   restrict to some columns (debugging)
 *   --batch=1000              rows read per query
 *
 * Idempotent: once every value is relative the plan is empty. Nothing is
 * deleted; file names are never printed (counts only).
 *
 * Run with:  npx ts-node prisma/scripts/uploads-url-normalize.ts --hosts=ms-api.example.com
 *            npx ts-node prisma/scripts/uploads-url-normalize.ts --hosts=... --apply --fingerprint=<hash>
 * Runbook:   plans/s3-storage/MIGRATION-RUNBOOK.md
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  UPLOAD_REF_COLUMNS,
  columnLabel,
  fingerprint,
  isNoop,
  newColumnStats,
  parseArgs,
  planRow,
  renderPlan,
  resolveHosts,
  type Options,
  type Plan,
  type UploadRefColumn,
} from './uploads-url-normalize.planner';

type Db = PrismaClient | Prisma.TransactionClient;

// ── Row streaming ───────────────────────────────────────────────────────────

/** Rows of one column in id order, `batch` at a time (never the whole table). */
export async function* streamRows(
  db: Db,
  c: {
    model: string;
    column: string;
    kind: 'url' | 'json' | 'key' | 'print_files';
  },
  batch: number,
): AsyncGenerator<{ id: string; value: unknown }> {
  const delegate = (db as unknown as Record<string, any>)[c.model];
  if (!delegate?.findMany)
    throw new Error(`Prisma model not found: ${c.model}`);
  let cursor: string | null = null;
  for (;;) {
    const rows: Array<Record<string, unknown>> = await delegate.findMany({
      take: batch,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      orderBy: { id: 'asc' },
      // No `not: null` filter: it is invalid for required String and for Json
      // columns in Prisma, so every row is paged through (cheap: id + 1 column).
      select: { id: true, [c.column]: true },
    });
    for (const r of rows) yield { id: r.id as string, value: r[c.column] };
    if (rows.length < batch) return;
    cursor = rows[rows.length - 1].id as string;
  }
}

// ── Planner ─────────────────────────────────────────────────────────────────

async function buildPlan(
  db: Db,
  opts: Options,
  hosts: string[],
): Promise<Plan> {
  const columns: UploadRefColumn[] = UPLOAD_REF_COLUMNS.filter(
    (c) => opts.only.length === 0 || opts.only.includes(columnLabel(c)),
  );
  const plan: Plan = { hosts, columns: [], changes: [] };
  for (const c of columns) {
    const stats = newColumnStats(c);
    plan.columns.push(stats);
    for await (const row of streamRows(db, c, opts.batch)) {
      const ch = planRow(c, row.id, row.value, hosts, stats);
      if (ch) plan.changes.push(ch);
    }
  }
  return plan;
}

// ── Writer ──────────────────────────────────────────────────────────────────

async function applyPlan(
  tx: Prisma.TransactionClient,
  plan: Plan,
): Promise<number> {
  let n = 0;
  for (const ch of plan.changes) {
    const delegate = (tx as unknown as Record<string, any>)[ch.model];
    await delegate.update({
      where: { id: ch.id },
      data: { [ch.column]: ch.next },
      select: { id: true },
    });
    n++;
  }
  return n;
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const opts = parseArgs(process.argv.slice(2));
  const hosts = resolveHosts(opts.hosts, process.env);
  const prisma = new PrismaClient();
  try {
    if (opts.mode === 'dry-run') {
      const plan = await buildPlan(prisma, opts, hosts);
      console.log(renderPlan(plan, 'dry-run'));
      if (isNoop(plan))
        console.log(
          '\nNothing to do: every upload URL of these hosts is already relative.',
        );
      else
        console.log(
          `\nRe-run with --apply --fingerprint=${fingerprint(plan)} to write.`,
        );
      return 0;
    }

    let outcome = 'noop' as 'applied' | 'noop' | 'mismatch';
    let updated = 0;
    await prisma.$transaction(
      async (tx) => {
        const plan = await buildPlan(tx, opts, hosts);
        console.log(renderPlan(plan, 'apply'));
        if (isNoop(plan)) {
          outcome = 'noop';
          return;
        }
        const fp = fingerprint(plan);
        if (fp !== opts.fingerprint) {
          outcome = 'mismatch';
          console.error(
            `\nREFUSED: fingerprint ${fp} differs from --fingerprint=${opts.fingerprint}; data changed since the dry run. Re-run the dry run.`,
          );
          return;
        }
        updated = await applyPlan(tx, plan);
        outcome = 'applied';
      },
      { timeout: 30 * 60 * 1000, maxWait: 30 * 1000 },
    );
    if (outcome === 'mismatch') return 2;
    if (outcome === 'noop') {
      console.log('\nNothing to do.');
      return 0;
    }
    console.log(`\nDone: ${updated} row(s) updated in one transaction.`);
    return 0;
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
