/**
 * Brings the PLATFORM default email templates of an existing database
 * (`NotificationTemplate`, one row per event) up to the current defaults of
 * prisma/platform-email-templates.ts — the same definitions `prisma/seed.ts`
 * writes into a fresh database. The seed never touches an existing row, so
 * a database seeded long ago keeps old texts (no {{items_html}}, only en/ar,
 * old brand name); this script is the way to update it.
 *
 * Rules (platform-email-templates-sync.planner.ts), per event, locale and
 * field (subject / body_html / body_text):
 *   - SAFE MERGE (default): missing rows are created, missing locales /
 *     fields are added, a stored text is replaced ONLY when it equals a
 *     known old default (platform-email-templates-sync.legacy.ts); any other
 *     differing text is kept and reported as "looks admin-edited";
 *   - --force: every differing text of the selected events is overwritten.
 * Only `NotificationTemplate` is written. Store templates
 * (`StoreNotificationTemplate`) are neither read nor written. `enabled` of
 * an existing row is left as it is; locales the defaults do not define stay.
 *
 * Modes:
 *   --dry-run (default)   report + fingerprint; no writes
 *   --apply               re-plan inside ONE transaction, write a JSON backup
 *                         of the current rows, then write
 *   --fingerprint=<hash>  optional with --apply: abort when the plan differs
 *                         from the dry run that printed this hash
 *   --events=a,b          restrict to some events
 *   --force               overwrite admin-edited texts too
 *   --backup-dir=<dir>    where the JSON backup goes (default
 *                         $MS_OPS_BACKUP_DIR, else /var/lib/multistores/backups;
 *                         checked in the dry run too, scripts/ops/backup-dir.js)
 *
 * Idempotent: a second run reports "Nothing to write". Template texts are
 * never printed (states and placeholder names only).
 *
 * Run with:
 *   npx ts-node prisma/scripts/platform-email-templates-sync.ts
 *   npx ts-node prisma/scripts/platform-email-templates-sync.ts --apply --fingerprint=<hash>
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';
import { buildPlatformEmailTemplates } from '../platform-email-templates';
import { knownOldTemplateSets } from './platform-email-templates-sync.legacy';
import {
  buildPlan,
  fingerprint,
  isNoop,
  parseArgs,
  renderPlan,
  selectEvents,
  type Options,
  type Plan,
} from './platform-email-templates-sync.planner';

type BackupDirCheck =
  | { ok: true; warning?: string }
  | { ok: false; error: string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const opsBackup = require('../../scripts/ops/backup-dir.js') as {
  resolveBackupDir: (o?: { argv?: string[]; envVar?: string }) => string;
  checkBackupDir: (dir: string) => BackupDirCheck;
};
const { resolveBackupDir, checkBackupDir } = opsBackup;

type Db = PrismaClient | Prisma.TransactionClient;

const DEFAULTS = buildPlatformEmailTemplates();
const KNOWN_OLD = knownOldTemplateSets();

/** Current platform rows of the selected events (platform table only). */
async function loadRows(db: Db, events: string[]) {
  return db.notificationTemplate.findMany({
    where: { event: { in: events } },
    orderBy: { event: 'asc' },
  });
}

async function applyPlan(
  tx: Prisma.TransactionClient,
  plan: Plan,
): Promise<number> {
  let n = 0;
  for (const e of plan.events) {
    if (e.action === 'none' || !e.next) continue;
    const data = {
      subject: e.next.subject as Prisma.InputJsonObject,
      body_html: e.next.body_html as Prisma.InputJsonObject,
      body_text: e.next.body_text as Prisma.InputJsonObject,
    };
    if (e.action === 'create') {
      await tx.notificationTemplate.create({
        data: { event: e.event, ...data, enabled: true },
        select: { id: true },
      });
    } else {
      // `enabled` is deliberately not part of the update.
      await tx.notificationTemplate.update({
        where: { event: e.event },
        data,
        select: { id: true },
      });
    }
    n++;
  }
  return n;
}

async function main(): Promise<number> {
  const opts: Options = parseArgs(process.argv.slice(2));
  const events = selectEvents(DEFAULTS, opts);

  // Dry run included: a backup that cannot be written stops the run here.
  const backupDir = resolveBackupDir();
  const check = checkBackupDir(backupDir);
  if (!check.ok) {
    console.error(`ERROR: ${check.error}`);
    return 1;
  }
  if (check.warning) console.warn(`WARNING: ${check.warning}`);
  console.log(`Backup dir: ${backupDir} (writable)`);

  const prisma = new PrismaClient();
  try {
    if (opts.mode === 'dry-run') {
      const plan = buildPlan(
        DEFAULTS,
        await loadRows(prisma, events),
        KNOWN_OLD,
        opts,
      );
      console.log(renderPlan(plan, 'dry-run'));
      if (isNoop(plan)) console.log('\nNothing to write.');
      else {
        const flags = [
          opts.events ? `--events=${opts.events.join(',')}` : '',
          opts.force ? '--force' : '',
        ]
          .filter(Boolean)
          .join(' ');
        console.log(
          `\nDRY RUN, nothing written. To write: same command${flags ? ` (${flags})` : ''} plus --apply --fingerprint=${fingerprint(plan)}`,
        );
      }
      return 0;
    }

    let outcome = 'noop' as 'applied' | 'noop' | 'mismatch';
    let written = 0;
    await prisma.$transaction(
      async (tx) => {
        const rows = await loadRows(tx, events);
        const plan = buildPlan(DEFAULTS, rows, KNOWN_OLD, opts);
        console.log(renderPlan(plan, 'apply'));
        if (isNoop(plan)) return;
        const fp = fingerprint(plan);
        if (opts.fingerprint && fp !== opts.fingerprint) {
          outcome = 'mismatch';
          console.error(
            `\nREFUSED: fingerprint ${fp} differs from --fingerprint=${opts.fingerprint}; the rows (or the options) changed since the dry run. Re-run the dry run.`,
          );
          return;
        }
        // Backup of the rows as they are, before anything is written.
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupFile = join(
          backupDir,
          `platform-email-templates-sync-${stamp}.json`,
        );
        writeFileSync(
          backupFile,
          JSON.stringify(
            { table: 'NotificationTemplate', force: opts.force, events, rows },
            null,
            2,
          ),
          { mode: 0o600 },
        );
        console.log(`\nBackup written: ${backupFile} (${rows.length} row(s))`);
        written = await applyPlan(tx, plan);
        outcome = 'applied';
      },
      { timeout: 60 * 1000, maxWait: 30 * 1000 },
    );
    if (outcome === 'mismatch') return 2;
    if (outcome === 'noop') {
      console.log('\nNothing to write.');
      return 0;
    }
    console.log(`\nDone: ${written} row(s) written in one transaction.`);
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
