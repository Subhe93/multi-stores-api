/**
 * `WORKERS=retention,backup,importer,designer` (M5 W1-C): one switch that
 * sets the four per-worker flags of this instance. A worker named in the
 * list is on, every other one is off; `WORKERS=` (empty) or `WORKERS=none`
 * turns all four off. The legacy per-worker flags always win when set:
 *   retention → RETENTION_SCHEDULER, backup → BACKUP_SCHEDULER,
 *   importer  → IMPORTER_WORKER,      designer → DESIGNER_RENDER_QUEUE
 * (DESIGNER_WORKER, the alias of DESIGNER_RENDER_QUEUE, also wins).
 * Applied once at module load, before any scheduler reads its flag.
 */

export const WORKERS_ENV = 'WORKERS';

export const WORKER_FLAGS: Record<WorkerName, readonly string[]> = {
  retention: ['RETENTION_SCHEDULER'],
  backup: ['BACKUP_SCHEDULER'],
  importer: ['IMPORTER_WORKER'],
  designer: ['DESIGNER_RENDER_QUEUE', 'DESIGNER_WORKER'],
};

export type WorkerName = 'retention' | 'backup' | 'importer' | 'designer';
export const WORKER_NAMES: readonly WorkerName[] = [
  'retention',
  'backup',
  'importer',
  'designer',
];

export interface WorkersEnvResult {
  /** WORKERS was set and parsed. */
  applied: boolean;
  /** Flags this call wrote (name → on|off). */
  set: Record<string, 'on' | 'off'>;
  /** Names in WORKERS that are not workers (ignored). */
  unknown: string[];
}

export function parseWorkersList(raw: string | undefined): WorkerName[] | null {
  if (raw === undefined) return null;
  const parts = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p !== '' && p !== 'none');
  return parts.filter((p): p is WorkerName =>
    (WORKER_NAMES as readonly string[]).includes(p),
  );
}

export function applyWorkersEnv(
  env: NodeJS.ProcessEnv = process.env,
): WorkersEnvResult {
  const raw = env[WORKERS_ENV];
  const result: WorkersEnvResult = { applied: false, set: {}, unknown: [] };
  if (raw === undefined) return result;
  result.applied = true;
  const wanted = new Set(parseWorkersList(raw) ?? []);
  result.unknown = raw
    .split(',')
    .map((p) => p.trim().toLowerCase())
    .filter(
      (p) =>
        p !== '' && p !== 'none' && !(WORKER_NAMES as string[]).includes(p),
    );
  for (const name of WORKER_NAMES) {
    const flags = WORKER_FLAGS[name];
    // A legacy flag that is set (even empty) wins.
    if (flags.some((f) => env[f] !== undefined)) continue;
    const value = wanted.has(name) ? 'on' : 'off';
    env[flags[0]] = value;
    result.set[flags[0]] = value;
  }
  return result;
}

/** The effective on/off of each worker on this instance (for ops status). */
export function workerFlags(
  env: NodeJS.ProcessEnv = process.env,
): Record<WorkerName, boolean> {
  const off = (v: string | undefined) =>
    ['off', 'false', '0', 'disabled', 'none'].includes(
      String(v ?? '')
        .trim()
        .toLowerCase(),
    );
  return {
    retention: !off(env.RETENTION_SCHEDULER),
    backup: !off(env.BACKUP_SCHEDULER),
    importer: !off(env.IMPORTER_WORKER),
    designer:
      !off(env.DESIGNER_RENDER_QUEUE) &&
      !off(env.DESIGNER_WORKER) &&
      !off(env.DESIGNER_RENDER_ENGINE),
  };
}
