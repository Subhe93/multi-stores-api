import type { PrismaService } from '../../prisma/prisma.service';
import {
  RetentionService,
  UnknownRetentionTaskError,
} from './retention.service';
import { RetentionScheduler } from './retention.scheduler';
import type { RetentionTask } from './retention.types';

/** Fake Prisma whose advisory lock answers `locked` (or follows a shared flag). */
function fakePrisma(lock: { held: boolean }) {
  const queries: string[] = [];
  return {
    queries,
    $transaction: jest.fn(
      async (
        fn: (tx: {
          $queryRaw: (...a: unknown[]) => Promise<unknown>;
        }) => Promise<void>,
      ) => {
        let mine = false;
        const tx = {
          $queryRaw: (strings: TemplateStringsArray, ...values: unknown[]) => {
            queries.push(strings.join('?') + ' ' + JSON.stringify(values));
            if (lock.held) return Promise.resolve([{ locked: false }]);
            lock.held = true;
            mine = true;
            return Promise.resolve([{ locked: true }]);
          },
        };
        try {
          await fn(tx);
        } finally {
          // Transaction-scoped lock: released on commit/rollback.
          if (mine) lock.held = false;
        }
      },
    ),
  };
}

function task(
  key: string,
  impl?: RetentionTask['run'],
): RetentionTask & {
  run: jest.Mock;
} {
  return {
    key,
    run: jest.fn(
      impl ?? (() => Promise.resolve({ purged: 1, skipped: 0, errors: 0 })),
    ),
  };
}

describe('RetentionService', () => {
  const NOW = new Date('2026-10-16T00:00:00Z');

  it('runs every task under the advisory lock with default options', async () => {
    const lock = { held: false };
    const prisma = fakePrisma(lock);
    const svc = new RetentionService(prisma as unknown as PrismaService);
    const a = task('a');
    const b = task('b');
    svc.registerTask(a);
    svc.registerTask(b);

    const out = await svc.run(NOW);
    expect(out.acquired).toBe(true);
    expect(Object.keys(out.results)).toEqual(['a', 'b']);
    expect(a.run).toHaveBeenCalledWith(NOW, {
      dryRun: false,
      limit: 500,
      deadline: expect.any(Number) as unknown,
    });
    expect(prisma.queries[0]).toContain('pg_try_advisory_xact_lock(hashtext(');
    expect(prisma.queries[0]).toContain('"m4-retention"');
    expect(lock.held).toBe(false);
  });

  it('does nothing when another instance holds the lock', async () => {
    const lock = { held: true };
    const svc = new RetentionService(
      fakePrisma(lock) as unknown as PrismaService,
    );
    const a = task('a');
    svc.registerTask(a);
    await expect(svc.run(NOW)).resolves.toEqual({
      acquired: false,
      results: {},
    });
    await expect(svc.runAll(NOW)).resolves.toEqual({});
    expect(a.run).not.toHaveBeenCalled();
  });

  it('never runs twice at once: overlapping calls and two instances', async () => {
    const lock = { held: false };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = task('slow', async () => {
      await gate;
      return { purged: 0, skipped: 0, errors: 0 };
    });

    const one = new RetentionService(
      fakePrisma(lock) as unknown as PrismaService,
    );
    const two = new RetentionService(
      fakePrisma(lock) as unknown as PrismaService,
    );
    one.registerTask(slow);
    two.registerTask(slow);

    const first = one.run(NOW);
    await new Promise((r) => setImmediate(r));
    // Same process: in-memory guard.
    await expect(one.run(NOW)).resolves.toEqual({
      acquired: false,
      results: {},
    });
    // Other instance: DB lock.
    await expect(two.run(NOW)).resolves.toEqual({
      acquired: false,
      results: {},
    });
    release();
    await expect(first).resolves.toMatchObject({ acquired: true });
    expect(slow.run).toHaveBeenCalledTimes(1);

    // After release the lock is free again.
    await expect(two.run(NOW)).resolves.toMatchObject({ acquired: true });
  });

  it('runs a single task with dry run and limit; unknown task throws', async () => {
    const svc = new RetentionService(
      fakePrisma({ held: false }) as unknown as PrismaService,
    );
    const a = task('a');
    const b = task('b');
    svc.registerTask(a);
    svc.registerTask(b);
    const out = await svc.run(NOW, { task: 'b', dryRun: true, limit: 7 });
    expect(Object.keys(out.results)).toEqual(['b']);
    expect(b.run).toHaveBeenCalledWith(NOW, {
      dryRun: true,
      limit: 7,
      deadline: expect.any(Number) as unknown,
    });
    expect(a.run).not.toHaveBeenCalled();
    await expect(svc.run(NOW, { task: 'nope' })).rejects.toBeInstanceOf(
      UnknownRetentionTaskError,
    );
    expect(svc.taskKeys()).toEqual(['a', 'b']);
  });

  it('a failing task reports one error and never stops the others', async () => {
    const svc = new RetentionService(
      fakePrisma({ held: false }) as unknown as PrismaService,
    );
    svc.registerTask(task('bad', () => Promise.reject(new Error('disk'))));
    const good = task('good');
    svc.registerTask(good);
    const results = await svc.runAll(NOW);
    expect(results.bad).toEqual({ purged: 0, skipped: 0, errors: 1 });
    expect(results.good).toEqual({ purged: 1, skipped: 0, errors: 0 });
  });

  it('replaces a task registered twice under the same key', async () => {
    const svc = new RetentionService(
      fakePrisma({ held: false }) as unknown as PrismaService,
    );
    const first = task('k');
    const second = task('k');
    svc.registerTask(first);
    svc.registerTask(second);
    await svc.runAll(NOW);
    expect(first.run).not.toHaveBeenCalled();
    expect(second.run).toHaveBeenCalledTimes(1);
  });
});

describe('RetentionScheduler', () => {
  afterEach(() => {
    delete process.env.RETENTION_SCHEDULER;
    jest.useRealTimers();
  });

  it('is disabled by RETENTION_SCHEDULER=off', () => {
    process.env.RETENTION_SCHEDULER = 'off';
    const spy = jest.spyOn(global, 'setInterval');
    const s = new RetentionScheduler({ run: jest.fn() } as never);
    s.onModuleInit();
    expect(spy).not.toHaveBeenCalled();
    s.onModuleDestroy();
    spy.mockRestore();
  });

  it('arms an hourly unref-ed timer and ticks into RetentionService.run', () => {
    jest.useFakeTimers();
    const run = jest.fn().mockResolvedValue({ acquired: true, results: {} });
    const s = new RetentionScheduler({ run } as never);
    s.onModuleInit();
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);
    s.onModuleDestroy();
    jest.advanceTimersByTime(60 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('skips a tick while the previous one is still running and survives errors', async () => {
    let release!: () => void;
    const run = jest
      .fn()
      .mockImplementationOnce(() => new Promise<void>((r) => (release = r)))
      .mockRejectedValueOnce(new Error('db down'));
    const s = new RetentionScheduler({ run } as never);
    const first = s.tick();
    await s.tick();
    expect(run).toHaveBeenCalledTimes(1);
    release();
    await first;
    await expect(s.tick()).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledTimes(2);
  });
});
