import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { Backup, BackupKind, BackupStatus } from '@prisma/client';

/**
 * The engine hands a COMPLETED backup to the offsite service and returns
 * the row it gets back; a PRE_RESTORE backup is copied in the background;
 * the files archive enters every configured directory with its own `-C`.
 * pg_dump / tar / disk probes are stubbed.
 */

const tools = {
  pgDump: jest.fn(async (_url: string, file: string) => {
    await fs.writeFile(file, 'dump');
    return { code: 0, signal: null, stderrTail: '', timedOut: false };
  }),
  runTool: jest.fn(async (_cmd: string, args: string[]) => {
    // `-czf <file>` → create the archive so fs.stat works.
    await fs.writeFile(args[1], 'tar');
    return { code: 0, signal: null, stderrTail: '', timedOut: false };
  }),
};

jest.mock('./backup-runner', () => {
  const actual = jest.requireActual('./backup-runner');
  return {
    ...actual,
    pgDump: (...a: unknown[]) => tools.pgDump(...(a as [string, string])),
    runTool: (...a: unknown[]) => tools.runTool(...(a as [string, string[]])),
    toolAvailable: jest.fn(async () => true),
    freeDiskBytes: jest.fn(async () => 1024 ** 4),
  };
});

import { archiveMembers, BackupsService } from './backups.service';

let dir: string;
let prevBackupDir: string | undefined;
let prevPrivate: string | undefined;
let prevInvoice: string | undefined;
let prevDriver: string | undefined;

beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ms-backups-'));
  prevBackupDir = process.env.BACKUP_DIR;
  prevPrivate = process.env.PRIVATE_STORAGE_DIR;
  prevInvoice = process.env.INVOICE_STORAGE_DIR;
  prevDriver = process.env.STORAGE_DRIVER;
  process.env.BACKUP_DIR = join(dir, 'backups');
  process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db';
  tools.pgDump.mockClear();
  tools.runTool.mockClear();
});
afterEach(async () => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore('BACKUP_DIR', prevBackupDir);
  restore('PRIVATE_STORAGE_DIR', prevPrivate);
  restore('INVOICE_STORAGE_DIR', prevInvoice);
  restore('STORAGE_DRIVER', prevDriver);
  await fs.rm(dir, { recursive: true, force: true });
});

function makePrisma() {
  const rows = new Map<string, Backup>();
  let n = 0;
  const prisma = {
    backup: {
      count: jest.fn(async () => 0),
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: { data: Partial<Backup> }) => {
        n += 1;
        const row = {
          id: `0000000${n}-0000-0000-0000-000000000000`,
          db_file: null,
          db_size_bytes: null,
          uploads_file: null,
          uploads_size_bytes: null,
          note: null,
          error: null,
          created_by: null,
          started_at: null,
          finished_at: null,
          created_at: new Date(),
          s3_key: null,
          s3_files_key: null,
          s3_etag: null,
          offsite_at: null,
          offsite_error: null,
          ...data,
        } as Backup;
        rows.set(row.id, row);
        return row;
      }),
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Backup>;
        }) => {
          const next = { ...rows.get(where.id)!, ...data } as Backup;
          rows.set(where.id, next);
          return next;
        },
      ),
    },
  };
  return { prisma, rows };
}

function makeOffsite(enabled = true) {
  let resolveUpload: ((row: Backup) => void) | null = null;
  const offsite = {
    uploadEnabled: enabled,
    uploadAfterBackup: jest.fn(
      (row: Backup) =>
        new Promise<Backup>((res) => {
          resolveUpload = res;
        }),
    ),
    ensureLocalFile: jest.fn(),
  };
  return {
    offsite,
    finishUpload: (row: Backup) => resolveUpload?.(row),
  };
}

describe('BackupsService → offsite copy', () => {
  it('uploads a completed MANUAL backup and returns the row with the keys', async () => {
    const { prisma } = makePrisma();
    const { offsite, finishUpload } = makeOffsite();
    const service = new BackupsService(prisma as never, offsite as never);

    const pending = service.createAndWait(BackupKind.MANUAL, {
      includeUploads: false,
    });
    // Wait until the engine hands the COMPLETED row over.
    await waitFor(() => offsite.uploadAfterBackup.mock.calls.length === 1);
    const handed = offsite.uploadAfterBackup.mock.calls[0][0] as Backup;
    expect(handed.status).toBe(BackupStatus.COMPLETED);
    expect(basename(handed.db_file!)).toMatch(/^db-.*\.dump$/);
    // Still busy while the upload runs: the slot is not released early.
    expect(await service.isBusy()).toBe(true);
    finishUpload({ ...handed, s3_key: 'db/2026-11-03/x.dump', s3_etag: 'e' });
    const out = await pending;
    expect(out.status).toBe(BackupStatus.COMPLETED);
    expect(out.s3_key).toBe('db/2026-11-03/x.dump');
    expect(out.s3_etag).toBe('e');
    expect(await service.isBusy()).toBe(false);
  });

  it('does not wait for the offsite copy of a PRE_RESTORE backup', async () => {
    const { prisma } = makePrisma();
    const { offsite } = makeOffsite();
    const service = new BackupsService(prisma as never, offsite as never);
    const out = await service.createAndWait(BackupKind.PRE_RESTORE, {}, true);
    expect(out.status).toBe(BackupStatus.COMPLETED);
    expect(offsite.uploadAfterBackup).toHaveBeenCalledTimes(1);
    expect(out.s3_key).toBeNull();
  });

  it('skips the sink when uploads are off and without an offsite service', async () => {
    const { prisma } = makePrisma();
    const { offsite } = makeOffsite(false);
    const off = new BackupsService(prisma as never, offsite as never);
    expect((await off.createAndWait(BackupKind.MANUAL)).status).toBe(
      'COMPLETED',
    );
    expect(offsite.uploadAfterBackup).not.toHaveBeenCalled();
    const none = new BackupsService(makePrisma().prisma as never);
    expect((await none.createAndWait(BackupKind.SCHEDULED)).status).toBe(
      'COMPLETED',
    );
  });

  it('the files archive enters every configured directory with its own -C', async () => {
    const priv = join(dir, 'lib', 'storage');
    const inv = join(dir, 'lib', 'invoices');
    await fs.mkdir(priv, { recursive: true });
    await fs.mkdir(inv, { recursive: true });
    process.env.PRIVATE_STORAGE_DIR = priv;
    process.env.INVOICE_STORAGE_DIR = inv;
    const { prisma } = makePrisma();
    const service = new BackupsService(prisma as never);
    const out = await service.createAndWait(BackupKind.MANUAL, {
      includeUploads: true,
    });
    expect(out.status).toBe(BackupStatus.COMPLETED);
    const [cmd, args] = tools.runTool.mock.calls[0] as [string, string[]];
    expect(cmd).toBe('tar');
    expect(args.slice(0, 3)).toEqual([
      '-czf',
      out.uploads_file,
      '--exclude=.*.tmp',
    ]);
    expect(args.slice(3)).toEqual([
      '-C',
      process.cwd(),
      'uploads',
      '-C',
      join(dir, 'lib'),
      'storage',
      '-C',
      join(dir, 'lib'),
      'invoices',
    ]);
  });
});

describe('archiveMembers', () => {
  it('drops uploads/ with the s3 driver and folds nested roots into their parent', async () => {
    const priv = join(dir, 'storage');
    await fs.mkdir(join(priv, 'invoices'), { recursive: true });
    process.env.PRIVATE_STORAGE_DIR = priv;
    const members = await archiveMembers({
      STORAGE_DRIVER: 's3',
      INVOICE_STORAGE_DIR: join(priv, 'invoices'),
    });
    expect(members.map((m) => [m.kind, m.cwd, m.name])).toEqual([
      ['private', dir, 'storage'],
    ]);
  });

  it('keeps uploads/ with the local driver and skips missing directories', async () => {
    process.env.PRIVATE_STORAGE_DIR = join(dir, 'does-not-exist');
    const members = await archiveMembers({
      STORAGE_DRIVER: 'local',
      INVOICE_STORAGE_DIR: join(dir, 'missing-too'),
    });
    expect(members.map((m) => [m.kind, m.name])).toEqual([
      ['uploads', 'uploads'],
    ]);
  });
});

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const until = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > until) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}
