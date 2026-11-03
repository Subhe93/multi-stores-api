import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Backup, BackupKind, BackupStatus } from '@prisma/client';
import {
  BackupOffsiteService,
  latestMarker,
  OFFSITE_MISSING_EVENT,
  OFFSITE_WATCHDOG_TASK,
} from './backup-offsite.service';
import { MemoryBackupObjectSink } from './memory-backup-sink';

/**
 * Offsite copy of in-app backups: upload + verify + row update, fetching a
 * rotated-out file back, and the hourly watchdog (one alert per day).
 */

const T0 = new Date('2026-11-03T10:00:00.000Z');

function backupRow(over: Partial<Backup> = {}): Backup {
  return {
    id: 'b1b2b3b4-0000-0000-0000-000000000000',
    kind: BackupKind.MANUAL,
    status: BackupStatus.COMPLETED,
    db_file: null,
    db_size_bytes: null,
    uploads_file: null,
    uploads_size_bytes: null,
    includes_uploads: false,
    note: null,
    error: null,
    created_by: null,
    started_at: T0,
    finished_at: T0,
    created_at: T0,
    s3_key: null,
    s3_files_key: null,
    s3_etag: null,
    offsite_at: null,
    offsite_error: null,
    ...over,
  };
}

function makePrisma() {
  const rows = new Map<string, Backup>();
  const emailLogs: { event: string; created_at: Date }[] = [];
  const prisma = {
    backup: {
      update: jest.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string };
          data: Partial<Backup>;
        }) => {
          const current = rows.get(where.id) ?? backupRow({ id: where.id });
          const next = { ...current, ...data } as Backup;
          rows.set(where.id, next);
          return next;
        },
      ),
    },
    emailLog: {
      findFirst: jest.fn(
        async ({
          where,
        }: {
          where: { event: string; created_at: { gte: Date } };
        }) =>
          emailLogs.find(
            (l) =>
              l.event === where.event && l.created_at >= where.created_at.gte,
          ) ?? null,
      ),
    },
  };
  return { prisma, rows, emailLogs };
}

function makeMail(recipients: string[] = ['ops@example.com']) {
  const mail = {
    adminRecipients: jest.fn(async () => recipients),
    sendOnboarding: jest.fn(
      async (_event: string, _to: string, _vars: Record<string, string>) => ({
        sent: true,
      }),
    ),
  };
  return mail;
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(join(tmpdir(), 'ms-offsite-'));
  delete process.env.BACKUP_OFFSITE_UPLOAD;
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('BackupOffsiteService.uploadAfterBackup', () => {
  it('uploads dump + files under db/<date>/ and files/<date>/, verifies and records the keys', async () => {
    const sink = new MemoryBackupObjectSink();
    const { prisma, rows } = makePrisma();
    const service = new BackupOffsiteService(prisma as never, sink);
    const dump = Buffer.from('pg_dump bytes');
    const tar = Buffer.from('tar.gz bytes');
    const dbFile = join(dir, 'db-20261103-100000-b1b2b3b4.dump');
    const upFile = join(dir, 'uploads-20261103-100000-b1b2b3b4.tar.gz');
    await fs.writeFile(dbFile, dump);
    await fs.writeFile(upFile, tar);
    const row = backupRow({ db_file: dbFile, uploads_file: upFile });

    const out = await service.uploadAfterBackup(row, T0);

    expect(out.s3_key).toBe('db/2026-11-03/db-20261103-100000-b1b2b3b4.dump');
    expect(out.s3_files_key).toBe(
      'files/2026-11-03/uploads-20261103-100000-b1b2b3b4.tar.gz',
    );
    expect(out.s3_etag).toBe('etag-1');
    expect(out.offsite_at).toBeInstanceOf(Date);
    expect(out.offsite_error).toBeNull();
    expect(rows.get(row.id)?.s3_key).toBe(out.s3_key);
    // Every object carries its sha256 and the stream length.
    const dbPut = sink.puts.find((p) => p.key === out.s3_key)!;
    expect(dbPut.options.sha256).toBe(sha256(dump));
    expect(dbPut.options.contentLength).toBe(dump.length);
    expect(dbPut.options.contentType).toBe('application/octet-stream');
    expect(sink.objects.get(out.s3_key!)!.body.equals(dump)).toBe(true);
    expect(sink.objects.get(out.s3_files_key!)!.body.equals(tar)).toBe(true);
    // A success marker next to the cron's `manifests/<date>.json`.
    const manifestKey = 'manifests/2026-11-03-app-b1b2b3b4.json';
    const manifest = JSON.parse(sink.objects.get(manifestKey)!.body.toString());
    expect(manifest).toMatchObject({
      source: 'app',
      backup_id: row.id,
      db_key: out.s3_key,
      db_sha256: sha256(dump),
      files_key: out.s3_files_key,
    });
  });

  it('records offsite_error and keeps the row when the upload fails', async () => {
    const sink = new MemoryBackupObjectSink();
    sink.failNextPut = new Error('AccessDenied: no');
    const { prisma, rows } = makePrisma();
    const service = new BackupOffsiteService(prisma as never, sink);
    const dbFile = join(dir, 'db-x.dump');
    await fs.writeFile(dbFile, 'd');
    const out = await service.uploadAfterBackup(
      backupRow({ db_file: dbFile }),
      T0,
    );
    expect(out.offsite_error).toContain('AccessDenied');
    expect(out.s3_key).toBeNull();
    expect(rows.get(out.id)?.offsite_error).toContain('AccessDenied');
  });

  it('fails verification when the stored size differs', async () => {
    const sink = new MemoryBackupObjectSink();
    sink.headSizeOverride = 999;
    const { prisma } = makePrisma();
    const service = new BackupOffsiteService(prisma as never, sink);
    const dbFile = join(dir, 'db-x.dump');
    await fs.writeFile(dbFile, 'd');
    const out = await service.uploadAfterBackup(
      backupRow({ db_file: dbFile }),
      T0,
    );
    expect(out.offsite_error).toMatch(/BACKUP_OFFSITE_VERIFY/);
  });

  it('does nothing with the no-op sink or BACKUP_OFFSITE_UPLOAD=off', async () => {
    const { prisma } = makePrisma();
    const dbFile = join(dir, 'db-x.dump');
    await fs.writeFile(dbFile, 'd');
    const row = backupRow({ db_file: dbFile });

    const off = new BackupOffsiteService(prisma as never);
    expect(off.uploadEnabled).toBe(false);
    expect(await off.uploadAfterBackup(row, T0)).toBe(row);

    process.env.BACKUP_OFFSITE_UPLOAD = 'off';
    const sink = new MemoryBackupObjectSink();
    const paused = new BackupOffsiteService(prisma as never, sink);
    expect(paused.uploadEnabled).toBe(false);
    expect(await paused.uploadAfterBackup(row, T0)).toBe(row);
    expect(sink.puts).toHaveLength(0);
    expect(prisma.backup.update).not.toHaveBeenCalled();
  });
});

describe('BackupOffsiteService.ensureLocalFile', () => {
  it('returns the local file when it exists and fetches it back otherwise', async () => {
    const sink = new MemoryBackupObjectSink();
    const { prisma, rows } = makePrisma();
    const service = new BackupOffsiteService(prisma as never, sink);
    const dump = Buffer.from('dump-content');
    const key = 'db/2026-11-01/db-old.dump';
    await sink.put(key, dump, {
      contentType: 'application/octet-stream',
      sha256: sha256(dump),
    });
    const gone = join(dir, 'rotated', 'db-old.dump');
    const row = backupRow({ db_file: gone, s3_key: key });

    const fetched = await service.ensureLocalFile(row, 'db', dir);
    expect(fetched).toBe(join(dir, 'db-old.dump'));
    expect((await fs.readFile(fetched!)).equals(dump)).toBe(true);
    expect(rows.get(row.id)?.db_file).toBe(fetched);

    // Present locally: no download, no update.
    prisma.backup.update.mockClear();
    const again = await service.ensureLocalFile(
      { ...row, db_file: fetched },
      'db',
      dir,
    );
    expect(again).toBe(fetched);
    expect(prisma.backup.update).not.toHaveBeenCalled();
  });

  it('is null when there is no key or the object is gone; a corrupt download is rejected', async () => {
    const sink = new MemoryBackupObjectSink();
    const { prisma } = makePrisma();
    const service = new BackupOffsiteService(prisma as never, sink);
    expect(
      await service.ensureLocalFile(
        backupRow({ db_file: join(dir, 'x') }),
        'db',
        dir,
      ),
    ).toBeNull();
    expect(
      await service.ensureLocalFile(
        backupRow({ s3_key: 'db/none' }),
        'db',
        dir,
      ),
    ).toBeNull();
    await sink.put('files/2026-11-01/f.tar.gz', Buffer.from('abc'), {
      contentType: 'application/gzip',
      sha256: 'deadbeef',
    });
    await expect(
      service.ensureLocalFile(
        backupRow({ s3_files_key: 'files/2026-11-01/f.tar.gz' }),
        'uploads',
        dir,
      ),
    ).rejects.toThrow(/sha256 mismatch/);
    await expect(fs.access(join(dir, 'f.tar.gz'))).rejects.toBeDefined();
  });
});

describe('BackupOffsiteService.watchdog', () => {
  it('registers as the retention task backups.offsite-watchdog', () => {
    const retention = { registerTask: jest.fn() };
    const service = new BackupOffsiteService(
      makePrisma().prisma as never,
      new MemoryBackupObjectSink(),
      makeMail() as never,
      retention as never,
    );
    service.onModuleInit();
    expect(retention.registerTask).toHaveBeenCalledWith(
      expect.objectContaining({ key: OFFSITE_WATCHDOG_TASK }),
    );
  });

  it('is quiet when a marker younger than 26 h exists', async () => {
    const sink = new MemoryBackupObjectSink();
    sink.seedManifest(
      'manifests/2026-11-03.json',
      new Date(T0.getTime() - 7 * 3_600_000),
    );
    const mail = makeMail();
    const service = new BackupOffsiteService(
      makePrisma().prisma as never,
      sink,
      mail as never,
    );
    const out = await service.watchdog(T0);
    expect(out).toMatchObject({ purged: 0, skipped: 1, errors: 0 });
    expect(out.details?.ok).toBe(1);
    expect(mail.sendOnboarding).not.toHaveBeenCalled();
  });

  it('alerts once per day when the newest marker is older than 26 h', async () => {
    const sink = new MemoryBackupObjectSink();
    sink.seedManifest(
      'manifests/2026-11-01.json',
      new Date(T0.getTime() - 30 * 3_600_000),
    );
    const mail = makeMail(['a@example.com', 'b@example.com']);
    const { prisma, emailLogs } = makePrisma();
    const service = new BackupOffsiteService(
      prisma as never,
      sink,
      mail as never,
    );

    const first = await service.watchdog(T0);
    expect(first.purged).toBe(1);
    expect(first.details?.sent).toBe(2);
    expect(mail.sendOnboarding).toHaveBeenCalledTimes(2);
    const [event, to, vars] = mail.sendOnboarding.mock.calls[0];
    expect(event).toBe(OFFSITE_MISSING_EVENT);
    expect(to).toBe('a@example.com');
    expect(vars.hours_since).toBe('30');
    expect(vars.bucket).toBe('memory://backups');
    expect(vars.admin_url).toMatch(/\/admin\/backups$/);

    // The EmailLog row written by the send dedupes the next hourly ticks.
    emailLogs.push({ event: OFFSITE_MISSING_EVENT, created_at: T0 });
    const second = await service.watchdog(new Date(T0.getTime() + 3_600_000));
    expect(second).toMatchObject({ purged: 0, skipped: 1 });
    expect(second.details?.alreadyAlerted).toBe(1);
    expect(mail.sendOnboarding).toHaveBeenCalledTimes(2);
  });

  it('alerts when no marker exists at all; dry-run only counts', async () => {
    const sink = new MemoryBackupObjectSink();
    const mail = makeMail();
    const service = new BackupOffsiteService(
      makePrisma().prisma as never,
      sink,
      mail as never,
    );
    const dry = await service.watchdog(T0, { dryRun: true });
    expect(dry.details?.wouldAlert).toBe(1);
    expect(mail.sendOnboarding).not.toHaveBeenCalled();
    const real = await service.watchdog(T0);
    expect(real.purged).toBe(1);
    const vars = mail.sendOnboarding.mock.calls[0][2];
    expect(vars.last_success).toBe('never');
  });

  it('skips with the no-op sink and reports a listing failure as an alert', async () => {
    const mail = makeMail();
    const off = new BackupOffsiteService(
      makePrisma().prisma as never,
      undefined,
      mail as never,
    );
    expect((await off.watchdog(T0)).details?.disabled).toBe(1);

    const sink = new MemoryBackupObjectSink();
    sink.list = jest.fn(async () => {
      throw new Error('ExpiredToken');
    });
    const broken = new BackupOffsiteService(
      makePrisma().prisma as never,
      sink,
      mail as never,
    );
    const out = await broken.watchdog(T0);
    expect(out.errors).toBe(1);
    expect(out.purged).toBe(1);
    const vars = mail.sendOnboarding.mock.calls[0][2];
    expect(vars.reason).toContain('ExpiredToken');
  });
});

describe('latestMarker', () => {
  it('prefers lastModified and falls back to the date in the key (end of day)', () => {
    const now = new Date('2026-11-03T10:00:00Z');
    expect(latestMarker([], now)).toBeNull();
    expect(
      latestMarker(
        [
          { key: 'manifests/2026-11-01.json', size: 1, lastModified: null },
          {
            key: 'manifests/2026-11-02-app-abc.json',
            size: 1,
            lastModified: null,
          },
          { key: 'manifests/notes.txt', size: 1, lastModified: now },
        ],
        now,
      )?.toISOString(),
    ).toBe('2026-11-02T23:59:59.999Z');
    const stamped = new Date('2026-11-03T03:40:00Z');
    expect(
      latestMarker(
        [{ key: 'manifests/2026-11-03.json', size: 1, lastModified: stamped }],
        now,
      ),
    ).toBe(stamped);
    // A key dated today never looks newer than now.
    expect(
      latestMarker(
        [{ key: 'manifests/2026-11-03.json', size: 1, lastModified: null }],
        now,
      ),
    ).toBe(now);
  });
});
