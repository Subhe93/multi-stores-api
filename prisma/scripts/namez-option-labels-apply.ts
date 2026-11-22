/**
 * M159 Namez option labels: writes the German / English display labels of
 * the variant option names and values (ProductTranslation.
 * variant_option_labels) of store namez-se through the real service
 * (ProductsService.setVariantOptionLabels), in a workers-off Nest application
 * context (WORKERS=none). No raw SQL. Rules and the plan:
 * namez-option-labels-apply.planner.ts. Runbook:
 * plans/namez-store-apps/M159-OPTION-TRANSLATIONS-DESIGN.md (section 14).
 *
 * Modes:
 *   --file=option-labels.json --store=namez-se [--dry-run]   (default)
 *       load the live products, print the plan and its fingerprint; no writes
 *   --file=... --store=... --apply --fingerprint=<hash> [--backup-dir=<dir>]
 *       re-plan, compare the fingerprint, write a backup (before + after per
 *       product and locale), then write product by product
 *   --restore=<backup.json> --store=... [--apply --fingerprint=<hash>] [--force]
 *       put every row of a backup back to its `before` labels (rows changed
 *       again after the apply are skipped unless --force)
 * Options: --locales=de,en (default: the file's meta.locales), --overwrite
 *   (replace a stored different label), --allow-missing (apply although a
 *   live name / value has no label in the file), --snapshot=<file> (offline
 *   dry run, no DB), --dump-snapshot=<file>.
 *
 * Run from the API directory with the production env loaded, e.g.
 *   npx ts-node prisma/scripts/namez-option-labels-apply.ts --file=... --store=namez-se
 */
import 'dotenv/config';
import * as fs from 'fs';
import * as path from 'path';
import {
  buildPlan,
  buildRestorePlan,
  fingerprint,
  parseArgs,
  planBlocked,
  renderPlan,
  renderRestorePlan,
  validateLabelsFile,
  writesByProduct,
  type BackupFile,
  type Change,
  type LabelsFile,
  type Options,
  type Snapshot,
} from './namez-option-labels-apply.planner';
import {
  productOptionSet,
  readVariantOptionLabels,
} from '../../src/common/catalog/variant-option-labels';

const DEFAULT_BACKUP_DIR = '/var/lib/multistores/backups';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Any = any;

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function readLabelsFile(file: string): LabelsFile {
  const raw = readJson(file);
  const issues = validateLabelsFile(raw);
  if (issues.length)
    throw new Error(
      `${file}: ${issues.length} issue(s):\n  ${issues.slice(0, 30).join('\n  ')}`,
    );
  return raw as LabelsFile;
}

function resolveBackupDir(o: Options): string {
  return (
    o.backupDir ||
    (process.env.MS_OPS_BACKUP_DIR || '').trim() ||
    DEFAULT_BACKUP_DIR
  );
}

function checkBackupDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probe, '', { mode: 0o600 });
  fs.unlinkSync(probe);
}

function writeBackup(file: string, backup: BackupFile): void {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(backup, null, 1), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

const stamp = () =>
  new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, 'Z');

// ── Nest context ────────────────────────────────────────────────────────────

interface Ctx {
  app: Any;
  prisma: Any;
  products: Any;
  revalidation: Any;
  CREATOR: Any;
}

async function bootstrap(): Promise<Ctx> {
  // No schedulers or queue workers in this process; the legacy per-worker
  // flags win over WORKERS, so they are forced off too.
  process.env.WORKERS = 'none';
  for (const f of [
    'RETENTION_SCHEDULER',
    'BACKUP_SCHEDULER',
    'IMPORTER_WORKER',
    'DESIGNER_RENDER_QUEUE',
    'DESIGNER_WORKER',
  ])
    process.env[f] = 'off';
  // BackupsService.onModuleInit marks PENDING/RUNNING backups as FAILED:
  // refuse to boot while one is in flight (same guard as the i18n script).
  {
    const { PrismaClient } = await import('@prisma/client');
    const pre = new PrismaClient();
    try {
      const active = await pre.backup.count({
        where: { status: { in: ['PENDING', 'RUNNING'] } },
      });
      if (active > 0)
        throw new Error(
          `${active} in-app backup(s) PENDING/RUNNING: wait until they finish and run again.`,
        );
    } finally {
      await pre.$disconnect();
    }
  }
  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = require('../../src/app.module');
  const { PrismaService } = require('../../src/prisma/prisma.service');
  const {
    ProductsService,
  } = require('../../src/modules/products/products.service');
  const {
    RevalidationService,
  } = require('../../src/common/revalidation/revalidation.service');
  const { UserRole } = await import('@prisma/client');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const get = (t: Any) => app.get(t, { strict: false });
  return {
    app,
    prisma: get(PrismaService),
    products: get(ProductsService),
    revalidation: get(RevalidationService),
    CREATOR: UserRole.CREATOR,
  };
}

interface StoreInfo {
  id: string;
  slug: string;
  creator_id: string;
  owner_user_id: string;
  primary_locale: string;
}

async function loadStore(ctx: Ctx, slug: string): Promise<StoreInfo> {
  const s = await ctx.prisma.store.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      creator_id: true,
      creator: { select: { user_id: true } },
      language_config: { select: { primary_locale: true } },
    },
  });
  if (!s) throw new Error(`Store "${slug}" not found.`);
  if (!s.creator?.user_id)
    throw new Error(`Store "${slug}" has no creator owner.`);
  return {
    id: s.id,
    slug: s.slug,
    creator_id: s.creator_id,
    owner_user_id: s.creator.user_id,
    primary_locale: s.language_config?.primary_locale ?? 'en',
  };
}

/** Reads only: every product of the store with its options and label rows. */
async function loadSnapshot(ctx: Ctx, store: StoreInfo): Promise<Snapshot> {
  const rows = await ctx.prisma.product.findMany({
    where: { creator_id: store.creator_id },
    select: {
      id: true,
      variant_option_config: true,
      variants: { select: { options: true } },
      translations: {
        select: { locale: true, slug: true, variant_option_labels: true },
      },
    },
  });
  return {
    store: {
      id: store.id,
      slug: store.slug,
      primary_locale: store.primary_locale,
    },
    products: rows.map((p: Any) => {
      const set = productOptionSet(
        p.variants.map((v: Any) => v.options),
        p.variant_option_config,
      );
      return {
        id: p.id,
        slug:
          p.translations.find((t: Any) => t.locale === store.primary_locale)
            ?.slug ?? null,
        options: Object.fromEntries([...set].map(([n, vs]) => [n, [...vs]])),
        rows: Object.fromEntries(
          p.translations.map((t: Any) => [
            t.locale,
            readVariantOptionLabels(t.variant_option_labels),
          ]),
        ),
      };
    }),
  };
}

async function writeChanges(
  ctx: Ctx,
  store: StoreInfo,
  changes: Change[],
  backup: BackupFile,
  file: string,
): Promise<unknown> {
  for (const [productId, byLocale] of writesByProduct(changes)) {
    try {
      const res = await ctx.products.setVariantOptionLabels(
        productId,
        store.owner_user_id,
        ctx.CREATOR,
        byLocale,
      );
      for (const l of Object.keys(byLocale))
        backup.applied.push(`${productId}:${l}`);
      writeBackup(file, backup);
      if (res.missingRow?.length)
        console.warn(`  ${productId}: no row for ${res.missingRow.join(', ')}`);
    } catch (err) {
      backup.failed = Object.keys(byLocale).map((l) => `${productId}:${l}`);
      writeBackup(file, backup);
      console.error(
        `FAILED at ${productId}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return err;
    }
  }
  return null;
}

function localesOf(o: Options, file: LabelsFile): string[] {
  const l = o.locales.length ? o.locales : (file.meta?.locales ?? []);
  if (!l.length)
    throw new Error(
      'No locales: pass --locales=de,en or set meta.locales in the file.',
    );
  return l;
}

async function runApplyMode(o: Options): Promise<number> {
  const file = readLabelsFile(o.file!);
  if (file.meta?.store && file.meta.store !== o.store)
    throw new Error(`file is for store ${file.meta.store}`);
  const opts = {
    locales: localesOf(o, file),
    overwrite: o.overwrite,
    allowMissing: o.allowMissing,
  };

  if (o.snapshot) {
    const snap = readJson(o.snapshot) as Snapshot;
    if (snap.store.slug !== o.store)
      throw new Error(`snapshot is for store ${snap.store.slug}`);
    const plan = buildPlan(snap, file, opts);
    console.log(renderPlan(plan));
    console.log(
      `\nFingerprint (offline snapshot, not valid for --apply): ${fingerprint(plan)}`,
    );
    return planBlocked(plan, opts) ? 1 : 0;
  }

  const backupDir = resolveBackupDir(o);
  checkBackupDir(backupDir);
  const ctx = await bootstrap();
  try {
    const store = await loadStore(ctx, o.store!);
    const snap = await loadSnapshot(ctx, store);
    if (o.dumpSnapshot) {
      fs.writeFileSync(o.dumpSnapshot, JSON.stringify(snap, null, 1), {
        mode: 0o600,
      });
      console.log(`Snapshot written to ${o.dumpSnapshot}`);
    }
    const plan = buildPlan(snap, file, opts);
    console.log(renderPlan(plan));
    const fp = fingerprint(plan);
    console.log(`\nFingerprint: ${fp}`);
    if (planBlocked(plan, opts)) {
      console.error(
        '\nLabels are missing for live options: add them to the file (or pass --allow-missing). Nothing written.',
      );
      return 1;
    }
    if (!plan.changes.length) {
      console.log('Nothing to write (already applied).');
      return 0;
    }
    if (o.mode === 'dry-run') {
      console.log(
        `\nDry run only. Apply with the same options plus: --apply --fingerprint=${fp}`,
      );
      return 0;
    }
    if (o.fingerprint !== fp) {
      console.error(
        o.fingerprint
          ? `Fingerprint mismatch: given ${o.fingerprint}, planned ${fp}.`
          : '--apply needs --fingerprint=<hash> from the dry run.',
      );
      return 1;
    }
    const backupFile = path.join(
      backupDir,
      `namez-option-labels-${store.slug}-${stamp()}.json`,
    );
    const backup: BackupFile = {
      format: 'namez-option-labels-backup/1',
      store: { id: store.id, slug: store.slug },
      created_at: new Date().toISOString(),
      fingerprint: fp,
      entities: plan.changes,
      applied: [],
    };
    writeBackup(backupFile, backup);
    console.log(`\nBackup: ${backupFile}`);
    const failed = await writeChanges(
      ctx,
      store,
      plan.changes,
      backup,
      backupFile,
    );
    console.log(
      `Applied ${backup.applied.length}/${plan.changes.length} row(s). Backup: ${backupFile}`,
    );
    await ctx.revalidation.revalidateStoreBySlug(store.slug);
    await ctx.revalidation.flush();
    console.log('Storefront cache revalidation requested.');
    if (failed) {
      console.error(
        `Stopped on an error. Undo with: --restore=${backupFile} --store=${store.slug}`,
      );
      return 1;
    }
    const again = buildPlan(await loadSnapshot(ctx, store), file, opts);
    console.log(
      `Re-plan after apply: ${again.changes.length} row(s) left to write (expected 0).`,
    );
    return 0;
  } finally {
    await ctx.app.close();
  }
}

async function runRestoreMode(o: Options): Promise<number> {
  const backup = readJson(o.restore!) as BackupFile;
  if (backup.format !== 'namez-option-labels-backup/1')
    throw new Error('not a namez-option-labels backup file');
  if (backup.store.slug !== o.store)
    throw new Error(`backup is for store ${backup.store.slug}`);
  const backupDir = resolveBackupDir(o);
  checkBackupDir(backupDir);
  const ctx = await bootstrap();
  try {
    const store = await loadStore(ctx, o.store!);
    if (store.id !== backup.store.id)
      throw new Error('store id differs from the backup');
    const plan = buildRestorePlan(
      backup,
      await loadSnapshot(ctx, store),
      o.force,
    );
    console.log(renderRestorePlan(plan));
    const fp = fingerprint(plan);
    console.log(`\nFingerprint: ${fp}`);
    if (!plan.changes.length) {
      console.log('Nothing to restore.');
      return 0;
    }
    if (o.mode === 'dry-run') {
      console.log(
        `\nDry run only. Restore with the same options plus: --apply --fingerprint=${fp}`,
      );
      return 0;
    }
    if (o.fingerprint !== fp) {
      console.error(
        o.fingerprint
          ? `Fingerprint mismatch: given ${o.fingerprint}, planned ${fp}.`
          : '--apply needs --fingerprint=<hash> from the dry run.',
      );
      return 1;
    }
    // The restore is itself backed up (and restorable).
    const file = path.join(
      backupDir,
      `namez-option-labels-${store.slug}-restore-${stamp()}.json`,
    );
    const own: BackupFile = {
      ...backup,
      created_at: new Date().toISOString(),
      fingerprint: fp,
      entities: plan.changes,
      applied: [],
      failed: [],
    };
    writeBackup(file, own);
    console.log(`Pre-restore backup: ${file}`);
    const failed = await writeChanges(ctx, store, plan.changes, own, file);
    console.log(
      `Restored ${own.applied.length}/${plan.changes.length} row(s).`,
    );
    await ctx.revalidation.revalidateStoreBySlug(store.slug);
    await ctx.revalidation.flush();
    return failed ? 1 : 0;
  } finally {
    await ctx.app.close();
  }
}

async function main(): Promise<number> {
  const o = parseArgs(process.argv.slice(2));
  if (o.restore) return runRestoreMode(o);
  return runApplyMode(o);
}

if (require.main === module) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
