import { BackupSchedulerService } from './backup-scheduler.service';

/**
 * The slot claim under `pg_try_advisory_xact_lock(hashtext('backups'))`:
 * two schedulers (two "instances") that both see the slot due, sharing one
 * fake database. Only the one that gets the lock and still sees the slot
 * due after the re-read produces a dump.
 */

interface Db {
  locked: boolean;
  last_run_at: Date | null;
  busy: boolean;
}

function fakeBackups(db: Db, runs: string[]) {
  return {
    readSchedule: jest.fn(() =>
      Promise.resolve({
        backup_enabled: true,
        backup_frequency: 'DAILY',
        backup_time: '03:00',
        backup_weekday: 0,
        backup_retention: 14,
        backup_include_uploads: true,
        backup_last_run_at: db.last_run_at,
      }),
    ),
    isBusy: jest.fn(() => Promise.resolve(db.busy)),
    markScheduledRun: jest.fn((at: Date) => {
      db.last_run_at = at;
      return Promise.resolve();
    }),
    createAndWait: jest.fn(() => {
      runs.push('dump');
      return Promise.resolve({ id: 'b1', status: 'COMPLETED', error: null });
    }),
    applyRetention: jest.fn(() => Promise.resolve(0)),
  };
}

function fakePrisma(db: Db) {
  return {
    $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const tx = {
        $queryRaw: jest.fn(() => {
          // Try-lock: the first caller gets it until the transaction ends.
          if (db.locked) return Promise.resolve([{ locked: false }]);
          db.locked = true;
          return Promise.resolve([{ locked: true }]);
        }),
      };
      try {
        return await fn(tx);
      } finally {
        db.locked = false;
      }
    }),
  };
}

const now = new Date(2026, 9, 17, 9, 0, 0); // slot 03:00 passed today

describe('BackupSchedulerService slot claim (advisory lock)', () => {
  it('claims under the lock, marks the slot and runs the dump once', async () => {
    const db: Db = { locked: false, last_run_at: null, busy: false };
    const runs: string[] = [];
    const backups = fakeBackups(db, runs);
    const s = new BackupSchedulerService(
      backups as never,
      fakePrisma(db) as never,
    );
    await s.tick(now);
    expect(backups.markScheduledRun).toHaveBeenCalledWith(now);
    expect(runs).toEqual(['dump']);
    // The next minute: the slot is marked, nothing runs.
    await s.tick(new Date(now.getTime() + 60_000));
    expect(runs).toEqual(['dump']);
    expect(backups.createAndWait).toHaveBeenCalledTimes(1);
  });

  it('a second instance re-reading under the lock finds the slot taken', async () => {
    const db: Db = { locked: false, last_run_at: null, busy: false };
    const runs: string[] = [];
    const a = new BackupSchedulerService(
      fakeBackups(db, runs) as never,
      fakePrisma(db) as never,
    );
    const b = new BackupSchedulerService(
      fakeBackups(db, runs) as never,
      fakePrisma(db) as never,
    );
    // Both read the schedule before either claims (both see "due").
    await Promise.all([a.tick(now), b.tick(now)]);
    expect(runs).toEqual(['dump']);
  });

  it('skips when another instance holds the lock', async () => {
    const db: Db = { locked: true, last_run_at: null, busy: false };
    const runs: string[] = [];
    const backups = fakeBackups(db, runs);
    const s = new BackupSchedulerService(
      backups as never,
      fakePrisma(db) as never,
    );
    await s.tick(now);
    expect(runs).toEqual([]);
    expect(backups.markScheduledRun).not.toHaveBeenCalled();
  });

  it('does not claim the slot while a backup is busy', async () => {
    const db: Db = { locked: false, last_run_at: null, busy: true };
    const runs: string[] = [];
    const backups = fakeBackups(db, runs);
    const s = new BackupSchedulerService(
      backups as never,
      fakePrisma(db) as never,
    );
    await s.tick(now);
    expect(runs).toEqual([]);
    expect(backups.markScheduledRun).not.toHaveBeenCalled();
    expect(db.last_run_at).toBeNull();
  });
});
