/**
 * One-time content rewrite for the platform domain move
 * (plans/domain-move/PLAN.md): absolute links to the OLD platform hosts
 * inside creator content become links to the NEW hosts.
 *
 *   https://<slug>.<old apex>/...   -> https://<slug>.<new apex>/...
 *   https://<old apex>/...          -> https://<new apex>/...
 *   https://<old dashboard host>/.. -> https://<new dashboard host>/..
 *   https://<old api host>/...      -> https://<new api host>/...   (not /uploads/)
 *
 * Columns: `LINK_COLUMNS` in `platform-links-rewrite.planner.ts` (menu
 * items, builder pages / sections / blocks / versions, static + legal pages,
 * store theme JSON, e-mail templates, rich-text descriptions, legal profile
 * website). Media URLs (`https://<api>/uploads/...`) are NOT touched here:
 * run `uploads-url-normalize.ts` for them. Merchant domains and order
 * history (`Store.custom_domain`, `Order.hostname`, ...) are never touched.
 *
 * Modes:
 *   --dry-run (default)       masked per-column report + fingerprint; no writes
 *   --apply --fingerprint=<hash>
 *                             re-plan inside ONE transaction, abort when the
 *                             fingerprint differs, then update row by row
 *   --from=<old apex> --to=<new apex>           required
 *   --dash-from=<host> --dash-to=<host>         optional (exact host)
 *   --api-from=<host> --api-to=<host>           optional (exact host, /uploads/ skipped)
 *   --only=model.column,...   restrict to some columns (debugging)
 *   --batch=1000              rows read per query
 *
 * Idempotent: once no value carries an old host the plan is empty. Nothing
 * is deleted; row values are never printed (counts only).
 *
 * Run with:
 *   npx ts-node prisma/scripts/platform-links-rewrite.ts \
 *     --from=iwings-digital.com --to=shopsdoor.com \
 *     --dash-from=ms-dash.iwings-digital.com --dash-to=app.shopsdoor.com \
 *     --api-from=ms-api.iwings-digital.com --api-to=api.shopsdoor.com
 *   ... same args ... --apply --fingerprint=<hash>
 */
import 'dotenv/config';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  LINK_COLUMNS,
  columnLabel,
  fingerprint,
  isNoop,
  newColumnStats,
  newPlan,
  parseArgs,
  planRow,
  renderPlan,
  type LinkColumn,
  type Options,
  type Plan,
} from './platform-links-rewrite.planner';
import { streamRows } from './uploads-url-normalize';

type Db = PrismaClient | Prisma.TransactionClient;

// ── Planner ─────────────────────────────────────────────────────────────────

async function buildPlan(db: Db, opts: Options): Promise<Plan> {
  const columns: LinkColumn[] = LINK_COLUMNS.filter(
    (c) => opts.only.length === 0 || opts.only.includes(columnLabel(c)),
  );
  const plan = newPlan(opts.rules);
  for (const c of columns) {
    const stats = newColumnStats(c);
    plan.columns.push(stats);
    // Same id-cursor streaming as uploads-url-normalize (kind is informational there).
    const rows = streamRows(
      db,
      { model: c.model, column: c.column, kind: c.kind === 'text' ? 'url' : 'json' },
      opts.batch,
    );
    for await (const row of rows) {
      const ch = planRow(plan, c, row.id, row.value, stats);
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
  const prisma = new PrismaClient();
  try {
    if (opts.mode === 'dry-run') {
      const plan = await buildPlan(prisma, opts);
      console.log(renderPlan(plan, 'dry-run'));
      if (isNoop(plan))
        console.log('\nNothing to do: no content links to the old hosts.');
      else
        console.log(
          `\nRe-run with the same host arguments plus --apply --fingerprint=${fingerprint(plan)} to write.`,
        );
      return 0;
    }

    let outcome = 'noop' as 'applied' | 'noop' | 'mismatch';
    let updated = 0;
    await prisma.$transaction(
      async (tx) => {
        const plan = await buildPlan(tx, opts);
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
