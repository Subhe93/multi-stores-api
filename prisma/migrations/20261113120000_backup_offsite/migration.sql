-- Offsite backups to S3 (plans/s3-storage, Phase 1). Hand-written.
-- Where the dump / files archive of a backup were copied to in the backup
-- bucket, the dump object's ETag, when the copy was verified, and the last
-- offsite error (the local backup itself stays COMPLETED).
ALTER TABLE "Backup"
    ADD COLUMN "s3_key" TEXT,
    ADD COLUMN "s3_files_key" TEXT,
    ADD COLUMN "s3_etag" TEXT,
    ADD COLUMN "offsite_at" TIMESTAMP(3),
    ADD COLUMN "offsite_error" TEXT;
