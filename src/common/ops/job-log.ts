import { Logger } from '@nestjs/common';
import { hostname } from 'os';

/**
 * One structured log line per scheduler tick (M5 W1-C, F13). Every
 * scheduler / worker (backup, retention, importer, designer print queue)
 * calls `logJobTick(job, fields)` once per pass. The line is JSON on the
 * `JobTick` logger so `pm2 logs api | grep JobTick` gives a timeline per
 * instance. Level by outcome: `ran` → log, `error` → warn, `idle` /
 * `skipped` → debug (the frequent no-op ticks stay out of the main log).
 *
 * The ops module registers a sink (`setJobTickSink`) that upserts the tick
 * into `OpsJobTick`, so `GET /admin/ops/status` can show the last tick per
 * job and instance across a multi-instance deployment. The sink is
 * fire-and-forget: a failing sink never affects the scheduler.
 */

export type JobTickOutcome = 'ran' | 'idle' | 'skipped' | 'error';

export interface JobTickFields {
  outcome: JobTickOutcome;
  [key: string]: unknown;
}

export interface JobTickRecord {
  job: string;
  instance: string;
  at: Date;
  fields: JobTickFields;
}

export type JobTickSink = (record: JobTickRecord) => void;

const logger = new Logger('JobTick');
let sink: JobTickSink | null = null;
let cachedInstanceId: string | null = null;

/**
 * Identity of this process across a PM2 cluster: `<hostname>:<pm_id|pid>`.
 * `OPS_INSTANCE_ID` overrides it (e.g. a container name).
 */
export function instanceId(): string {
  if (cachedInstanceId) return cachedInstanceId;
  const explicit = process.env.OPS_INSTANCE_ID?.trim();
  const pm = process.env.pm_id?.trim() || process.env.NODE_APP_INSTANCE?.trim();
  cachedInstanceId =
    explicit || `${hostname()}:${pm ? `pm${pm}` : process.pid}`;
  return cachedInstanceId;
}

/** Registers (or clears with null) the sink that persists ticks. */
export function setJobTickSink(next: JobTickSink | null): void {
  sink = next;
}

/** Logs one scheduler tick and hands it to the sink (never throws). */
export function logJobTick(job: string, fields: JobTickFields): void {
  const at = new Date();
  const record: JobTickRecord = { job, instance: instanceId(), at, fields };
  const line = JSON.stringify({
    job,
    instance: record.instance,
    at: at.toISOString(),
    ...fields,
  });
  switch (fields.outcome) {
    case 'ran':
      logger.log(line);
      break;
    case 'error':
      logger.warn(line);
      break;
    default:
      logger.debug(line);
  }
  if (!sink) return;
  try {
    sink(record);
  } catch (err) {
    logger.debug(
      `Job tick sink failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
