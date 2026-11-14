import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// scripts/ops/backup-dir.js: the one-off ops scripts ran as `multistores`
// with a /root default they could not write (QA 2026-11-14).

type CheckResult = { ok: true } | { ok: false; error: string };
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ops = require('../../../scripts/ops/backup-dir.js') as {
  DEFAULT_OPS_BACKUP_DIR: string;
  resolveBackupDir: (o?: {
    argv?: string[];
    env?: Record<string, string | undefined>;
    envVar?: string;
  }) => string;
  checkBackupDir: (
    dir: string,
    o?: { fsImpl?: Partial<typeof fs>; getuid?: () => number },
  ) => CheckResult & { warning?: string };
};

describe('ops backup dir', () => {
  it('defaults to a dir the runtime user owns, never /root', () => {
    expect(ops.DEFAULT_OPS_BACKUP_DIR).toBe('/var/lib/multistores/backups');
    expect(ops.resolveBackupDir({ argv: [], env: {} })).toBe(
      '/var/lib/multistores/backups',
    );
    expect(ops.DEFAULT_OPS_BACKUP_DIR.startsWith('/root')).toBe(false);
  });

  it('precedence: --backup-dir, then MS_OPS_BACKUP_DIR, then the script env var', () => {
    const env = {
      MS_OPS_BACKUP_DIR: '/srv/ops',
      NAMEZ_LEGAL_BACKUP_DIR: '/srv/legal',
    };
    expect(
      ops.resolveBackupDir({
        argv: ['node', 's.js', '--backup-dir=/tmp/x'],
        env,
        envVar: 'NAMEZ_LEGAL_BACKUP_DIR',
      }),
    ).toBe('/tmp/x');
    expect(
      ops.resolveBackupDir({ argv: [], env, envVar: 'NAMEZ_LEGAL_BACKUP_DIR' }),
    ).toBe('/srv/ops');
    expect(
      ops.resolveBackupDir({
        argv: [],
        env: { NAMEZ_LEGAL_BACKUP_DIR: '/srv/legal' },
        envVar: 'NAMEZ_LEGAL_BACKUP_DIR',
      }),
    ).toBe('/srv/legal');
    // Blank values fall through.
    expect(
      ops.resolveBackupDir({
        argv: ['--backup-dir= '],
        env: { MS_OPS_BACKUP_DIR: ' ' },
      }),
    ).toBe('/var/lib/multistores/backups');
  });

  it('creates a missing dir and leaves no probe file behind', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-backup-'));
    try {
      const dir = path.join(root, 'nested', 'backups');
      expect(ops.checkBackupDir(dir)).toEqual({ ok: true });
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('as root, hands a newly created dir to the owner of the parent', () => {
    const chowned: Array<[string, number, number]> = [];
    const fsImpl = {
      mkdirSync: (() =>
        '/var/lib/multistores/backups') as unknown as typeof fs.mkdirSync,
      statSync: ((p: string) => {
        expect(p).toBe('/var/lib/multistores');
        return { uid: 998, gid: 997 };
      }) as unknown as typeof fs.statSync,
      chownSync: ((p: string, uid: number, gid: number) => {
        chowned.push([p, uid, gid]);
      }) as unknown as typeof fs.chownSync,
      writeFileSync: (() => undefined) as unknown as typeof fs.writeFileSync,
      unlinkSync: (() => undefined) as unknown as typeof fs.unlinkSync,
    };
    const res = ops.checkBackupDir('/var/lib/multistores/backups', {
      fsImpl,
      getuid: () => 0,
    });
    expect(res.ok).toBe(true);
    expect(res.warning).toContain('uid 998');
    expect(chowned).toEqual([
      [path.resolve('/var/lib/multistores/backups'), 998, 997],
    ]);
  });

  it('does not chown when the dir already existed or the user is not root', () => {
    const chownSync = jest.fn();
    const base = {
      statSync: (() => ({ uid: 998, gid: 997 })) as unknown as typeof fs.statSync,
      chownSync: chownSync as unknown as typeof fs.chownSync,
      writeFileSync: (() => undefined) as unknown as typeof fs.writeFileSync,
      unlinkSync: (() => undefined) as unknown as typeof fs.unlinkSync,
    };
    const existed = ops.checkBackupDir('/srv/b', {
      fsImpl: { ...base, mkdirSync: (() => undefined) as unknown as typeof fs.mkdirSync },
      getuid: () => 0,
    });
    const notRoot = ops.checkBackupDir('/srv/b', {
      fsImpl: { ...base, mkdirSync: (() => '/srv/b') as unknown as typeof fs.mkdirSync },
      getuid: () => 998,
    });
    expect(existed).toEqual({ ok: true });
    expect(notRoot).toEqual({ ok: true });
    expect(chownSync).not.toHaveBeenCalled();
  });

  it('reports a dir it cannot write instead of throwing', () => {
    const denied = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    const res = ops.checkBackupDir('/root/backups/multi-stores', {
      fsImpl: {
        mkdirSync: (() => {
          throw denied;
        }) as unknown as typeof fs.mkdirSync,
      },
    });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toContain(
      '/root/backups/multi-stores is not writable',
    );
    expect(!res.ok && res.error).toContain('EACCES');
    expect(!res.ok && res.error).toContain('--backup-dir');
  });
});
