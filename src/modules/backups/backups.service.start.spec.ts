import { ConflictException } from '@nestjs/common';
import { BackupKind, BackupStatus } from '@prisma/client';
import { BackupsService } from './backups.service';

/**
 * `start()` race: two manual backups requested in the same process before
 * either row exists (the busy check awaits the row count, the disk guard and
 * the insert). Only one may insert a row and start a dump; the other answers
 * 409 BACKUP_ALREADY_RUNNING. A refused or failed start must not leave the
 * slot claimed.
 */

function row(id: string) {
  return {
    id,
    kind: BackupKind.MANUAL,
    status: BackupStatus.PENDING,
    includes_uploads: false,
    note: null,
    created_by: null,
    db_size_bytes: null,
    uploads_size_bytes: null,
  };
}

function makeService(opts: { diskFails?: boolean } = {}) {
  let inserted = 0;
  const prisma = {
    backup: {
      // The count never sees a pending insert: both callers get 0 before
      // either row exists, as they would with a real database.
      count: jest.fn(
        () => new Promise<number>((res) => setTimeout(() => res(0), 5)),
      ),
      create: jest.fn(() => {
        inserted += 1;
        return Promise.resolve(row(`b${inserted}`));
      }),
    },
  };
  const service = new BackupsService(prisma as never);
  const svc = service as unknown as {
    assertDiskSpace: () => Promise<void>;
    run: (r: unknown) => Promise<unknown>;
  };
  jest
    .spyOn(svc, 'assertDiskSpace')
    .mockImplementation(() =>
      opts.diskFails
        ? Promise.reject(new ConflictException({ code: 'BACKUP_DISK_FULL' }))
        : Promise.resolve(),
    );
  const run = jest
    .spyOn(svc, 'run')
    .mockImplementation(() => new Promise(() => undefined));
  return { service, prisma, run };
}

describe('BackupsService.start (concurrent manual backups)', () => {
  it('lets exactly one of two concurrent create() calls insert and run', async () => {
    const { service, prisma, run } = makeService();
    const results = await Promise.allSettled([
      service.create(BackupKind.MANUAL),
      service.create(BackupKind.MANUAL),
    ]);
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0].reason).toBeInstanceOf(ConflictException);
    expect((failed[0].reason as ConflictException).getResponse()).toMatchObject(
      { code: 'BACKUP_ALREADY_RUNNING' },
    );
    expect(prisma.backup.create).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    // The slot is now held by the running backup.
    await expect(service.isBusy()).resolves.toBe(true);
  });

  it('releases the claim when a start fails before the insert', async () => {
    const { service, prisma } = makeService({ diskFails: true });
    await expect(service.create(BackupKind.MANUAL)).rejects.toMatchObject({
      response: { code: 'BACKUP_DISK_FULL' },
    });
    expect(prisma.backup.create).not.toHaveBeenCalled();
    // Not stuck: a later request is evaluated again, not refused outright.
    await expect(service.isBusy()).resolves.toBe(false);
    await expect(service.create(BackupKind.MANUAL)).rejects.toMatchObject({
      response: { code: 'BACKUP_DISK_FULL' },
    });
    expect(prisma.backup.count).toHaveBeenCalledTimes(3);
  });
});
