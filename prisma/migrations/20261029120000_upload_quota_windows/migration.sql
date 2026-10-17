-- M5 W1-C operability: shared counters for multi-instance deployments.
-- Additive: two new tables, no changes to existing objects.

-- Upload byte budgets (customer uploads + designer photos) per scope/key and
-- UTC day, replacing the per-process in-memory counters. One row per
-- (scope, key, day); incremented atomically with INSERT ... ON CONFLICT.
-- Purged by the retention task `ops.quota-windows` (rows older than 2 days).
CREATE TABLE "UploadQuotaWindow" (
    "scope" VARCHAR(32) NOT NULL,
    "key" VARCHAR(64) NOT NULL,
    "window_start" TIMESTAMP(3) NOT NULL,
    "bytes" BIGINT NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadQuotaWindow_pkey" PRIMARY KEY ("scope","key","window_start")
);

CREATE INDEX "UploadQuotaWindow_window_start_idx" ON "UploadQuotaWindow"("window_start");

-- Last scheduler tick per (job, instance), written by `logJobTick()`; the
-- ops status endpoint reads it (retention last run per task, paused print
-- workers, importer ticks). `ran_at`/`ran_payload` keep the last tick that
-- did work even when later ticks were idle. Purged by `ops.job-ticks`.
CREATE TABLE "OpsJobTick" (
    "job" VARCHAR(64) NOT NULL,
    "instance" VARCHAR(191) NOT NULL,
    "ticked_at" TIMESTAMP(3) NOT NULL,
    "outcome" VARCHAR(16) NOT NULL,
    "payload" JSONB,
    "ran_at" TIMESTAMP(3),
    "ran_payload" JSONB,

    CONSTRAINT "OpsJobTick_pkey" PRIMARY KEY ("job","instance")
);

CREATE INDEX "OpsJobTick_ticked_at_idx" ON "OpsJobTick"("ticked_at");
