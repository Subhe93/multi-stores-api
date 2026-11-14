/**
 * Backup directory of the one-off ops scripts (scripts/ops/namez-*.js).
 *
 * The API runs as the system user `multistores` (home /var/lib/multistores),
 * which cannot write under /root. The default therefore lives in that home:
 * /var/lib/multistores/backups (created if missing). Order of precedence:
 * --backup-dir=<dir>, then $MS_OPS_BACKUP_DIR, then a script-specific
 * environment variable (if the script names one), then the default.
 *
 * checkBackupDir() runs in the DRY RUN too: a backup that cannot be written
 * must stop the run before --apply is even tried, not after the plan was
 * reviewed.
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_OPS_BACKUP_DIR = '/var/lib/multistores/backups';

/** The backup dir for this run (see the precedence above). */
function resolveBackupDir({ argv = process.argv, env = process.env, envVar } = {}) {
  const prefix = '--backup-dir=';
  const hit = argv.find((a) => a.startsWith(prefix));
  const fromArg = hit ? hit.slice(prefix.length).trim() : '';
  return (
    fromArg ||
    (env.MS_OPS_BACKUP_DIR || '').trim() ||
    (envVar ? (env[envVar] || '').trim() : '') ||
    DEFAULT_OPS_BACKUP_DIR
  );
}

/**
 * When root (sudo) just created the dir, hand every newly created level to
 * the owner of the existing parent. Otherwise a dry run under sudo leaves a
 * root-owned dir that the later `--apply` as `multistores` cannot write.
 * Returns a warning line, or null when nothing was changed.
 */
function chownCreatedToParentOwner(dir, firstCreated, fsImpl) {
  const parent = path.dirname(firstCreated);
  const { uid, gid } = fsImpl.statSync(parent);
  if (uid === 0) return null;
  // Every level from the first created dir down to `dir`.
  const levels = [];
  for (let cur = path.resolve(dir); ; cur = path.dirname(cur)) {
    levels.push(cur);
    if (cur === path.resolve(firstCreated) || path.dirname(cur) === cur) break;
  }
  for (const level of levels) fsImpl.chownSync(level, uid, gid);
  return `Created ${firstCreated} as root; ownership handed to uid ${uid} (owner of ${parent}).`;
}

/**
 * Creates the dir if missing and proves it is writable by writing and
 * removing a probe file (W_OK alone misses read-only mounts and ACLs).
 * Returns { ok: true, warning? } or { ok: false, error } with a readable
 * message; never throws.
 */
function checkBackupDir(dir, { fsImpl = fs, getuid = process.getuid } = {}) {
  try {
    const firstCreated = fsImpl.mkdirSync(dir, { recursive: true });
    let warning = null;
    if (firstCreated && typeof getuid === 'function' && getuid() === 0) {
      warning = chownCreatedToParentOwner(dir, firstCreated, fsImpl);
    }
    const probe = path.join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    fsImpl.writeFileSync(probe, '', { mode: 0o600 });
    fsImpl.unlinkSync(probe);
    return warning ? { ok: true, warning } : { ok: true };
  } catch (err) {
    const who = typeof getuid === 'function' ? ` (uid ${getuid()})` : '';
    return {
      ok: false,
      error:
        `Backup dir ${dir} is not writable for this user${who}: ${err.code || err.message}. ` +
        'Pass --backup-dir=<writable dir> or set MS_OPS_BACKUP_DIR.',
    };
  }
}

module.exports = { DEFAULT_OPS_BACKUP_DIR, resolveBackupDir, checkBackupDir };
