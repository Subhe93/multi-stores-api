-- Admin backups (plans/backups/API-CONTRACT.md): one row per pg_dump run
-- (manual, scheduled, or the automatic pre-restore one) plus the scheduler
-- settings on PlatformConfig. Files live under BACKUP_DIR on the server; the
-- rows only hold their absolute paths and sizes.

-- CreateEnum
CREATE TYPE "BackupKind" AS ENUM ('MANUAL', 'SCHEDULED', 'PRE_RESTORE');

-- CreateEnum
CREATE TYPE "BackupStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- AlterTable
ALTER TABLE "PlatformConfig" ADD COLUMN     "backup_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "backup_frequency" TEXT NOT NULL DEFAULT 'DAILY',
ADD COLUMN     "backup_time" TEXT NOT NULL DEFAULT '03:00',
ADD COLUMN     "backup_weekday" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "backup_retention" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN     "backup_include_uploads" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "backup_last_run_at" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "Backup" (
    "id" TEXT NOT NULL,
    "kind" "BackupKind" NOT NULL,
    "status" "BackupStatus" NOT NULL DEFAULT 'PENDING',
    "db_file" TEXT,
    "db_size_bytes" BIGINT,
    "uploads_file" TEXT,
    "uploads_size_bytes" BIGINT,
    "includes_uploads" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT,
    "error" TEXT,
    "created_by" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Backup_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Backup_created_at_idx" ON "Backup"("created_at");
