-- Importer store app (M4.4) + platform redirects.
-- Hand-written from the M4.4 design (§3). Every new column on an existing
-- table is nullable or defaulted, and the new unique indexes include a
-- nullable column (NULLs are distinct in Postgres), so existing rows are
-- untouched. New tables start empty. Nothing is backfilled.
-- Migration #6 in the global M4 order (M4-INTEGRATION §1.6).

-- CreateEnum
CREATE TYPE "ImportSourceKind" AS ENUM ('WP_BUNDLE', 'WC_REST');

-- CreateEnum
CREATE TYPE "ImportRunStatus" AS ENUM ('UPLOADED', 'PLANNING', 'PLANNED', 'PLAN_FAILED', 'QUEUED', 'RUNNING', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED', 'ROLLBACK_QUEUED', 'ROLLING_BACK', 'ROLLED_BACK', 'ROLLBACK_FAILED');

-- CreateEnum
CREATE TYPE "ImportItemPhase" AS ENUM ('PLAN', 'APPLY', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "ImportItemAction" AS ENUM ('CREATE', 'UPDATE', 'UNCHANGED', 'SKIP', 'CONFLICT', 'ERROR', 'DELETE', 'ARCHIVE', 'STAGE');

-- CreateEnum
CREATE TYPE "ImportLogLevel" AS ENUM ('INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "ImportEntityStatus" AS ENUM ('ACTIVE', 'STAGED', 'ROLLED_BACK');

-- CreateEnum
CREATE TYPE "RedirectSource" AS ENUM ('IMPORT', 'MANUAL');

-- AlterTable
ALTER TABLE "CreatorCategory" ADD COLUMN     "external_ref" VARCHAR(191),
ADD COLUMN     "noindex_when_empty" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "CreatorCategoryTranslation" ADD COLUMN     "meta_desc" TEXT,
ADD COLUMN     "meta_title" TEXT;

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "external_ref" VARCHAR(191);

-- AlterTable
ALTER TABLE "ProductTranslation" ADD COLUMN     "short_description" TEXT;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "external_ref" VARCHAR(191);

-- CreateTable
CREATE TABLE "ImportSource" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" "ImportSourceKind" NOT NULL,
    "name" TEXT NOT NULL,
    "site_host" VARCHAR(253) NOT NULL,
    "host_aliases" TEXT[],
    "credentials_enc" TEXT,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "last_verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRun" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "status" "ImportRunStatus" NOT NULL DEFAULT 'UPLOADED',
    "bundle_key" TEXT,
    "bundle_sha256" VARCHAR(64),
    "bundle_bytes" INTEGER,
    "snapshot_key" TEXT,
    "catalog_hash" VARCHAR(64),
    "options" JSONB NOT NULL DEFAULT '{}',
    "plan_fingerprint" VARCHAR(64),
    "summary" JSONB,
    "progress" JSONB,
    "error" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "worker_id" TEXT,
    "heartbeat_at" TIMESTAMP(3),
    "cancel_requested_at" TIMESTAMP(3),
    "created_by" TEXT,
    "confirmed_by" TEXT,
    "rollback_by" TEXT,
    "planned_at" TIMESTAMP(3),
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRunItem" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "phase" "ImportItemPhase" NOT NULL,
    "entity_type" VARCHAR(32) NOT NULL,
    "external_ref" VARCHAR(255) NOT NULL,
    "action" "ImportItemAction" NOT NULL,
    "target_id" TEXT,
    "before" JSONB,
    "diff" JSONB,
    "message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRunItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportRunLog" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "level" "ImportLogLevel" NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "entity_type" VARCHAR(32),
    "external_ref" VARCHAR(255),
    "message" TEXT NOT NULL,
    "data" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportRunLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportEntity" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "entity_type" VARCHAR(32) NOT NULL,
    "external_ref" VARCHAR(255) NOT NULL,
    "target_id" TEXT,
    "source_hash" VARCHAR(64) NOT NULL,
    "applied_hash" VARCHAR(64),
    "created_by_import" BOOLEAN NOT NULL DEFAULT true,
    "status" "ImportEntityStatus" NOT NULL DEFAULT 'ACTIVE',
    "payload" JSONB,
    "first_run_id" TEXT NOT NULL,
    "last_run_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ImportEntity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportMedia" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "source_url" VARCHAR(1024) NOT NULL,
    "fetched_url" VARCHAR(1024),
    "sha256" VARCHAR(64) NOT NULL,
    "mime" VARCHAR(64) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "public_url" TEXT,
    "private_key" TEXT,
    "first_run_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreRedirect" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "from_path" VARCHAR(1024) NOT NULL,
    "to_path" VARCHAR(1024) NOT NULL,
    "status_code" INTEGER NOT NULL DEFAULT 301,
    "source" "RedirectSource" NOT NULL DEFAULT 'MANUAL',
    "import_run_id" TEXT,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreRedirect_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ImportSource_store_id_idx" ON "ImportSource"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "ImportSource_store_id_site_host_kind_key" ON "ImportSource"("store_id", "site_host", "kind");

-- CreateIndex
CREATE INDEX "ImportRun_store_id_created_at_idx" ON "ImportRun"("store_id", "created_at");

-- CreateIndex
CREATE INDEX "ImportRun_status_idx" ON "ImportRun"("status");

-- CreateIndex
CREATE INDEX "ImportRunItem_run_id_phase_entity_type_idx" ON "ImportRunItem"("run_id", "phase", "entity_type");

-- CreateIndex
CREATE INDEX "ImportRunLog_run_id_level_idx" ON "ImportRunLog"("run_id", "level");

-- CreateIndex
CREATE INDEX "ImportEntity_store_id_first_run_id_idx" ON "ImportEntity"("store_id", "first_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "ImportEntity_store_id_entity_type_external_ref_key" ON "ImportEntity"("store_id", "entity_type", "external_ref");

-- CreateIndex
CREATE INDEX "ImportMedia_store_id_sha256_idx" ON "ImportMedia"("store_id", "sha256");

-- CreateIndex
CREATE UNIQUE INDEX "ImportMedia_store_id_source_url_key" ON "ImportMedia"("store_id", "source_url");

-- CreateIndex
CREATE INDEX "StoreRedirect_store_id_updated_at_idx" ON "StoreRedirect"("store_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "StoreRedirect_store_id_from_path_key" ON "StoreRedirect"("store_id", "from_path");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorCategory_creator_id_external_ref_key" ON "CreatorCategory"("creator_id", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "Product_creator_id_external_ref_key" ON "Product"("creator_id", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_product_id_external_ref_key" ON "ProductVariant"("product_id", "external_ref");

-- AddForeignKey
ALTER TABLE "ImportSource" ADD CONSTRAINT "ImportSource_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRun" ADD CONSTRAINT "ImportRun_source_id_fkey" FOREIGN KEY ("source_id") REFERENCES "ImportSource"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRunItem" ADD CONSTRAINT "ImportRunItem_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ImportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ImportRunLog" ADD CONSTRAINT "ImportRunLog_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "ImportRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreRedirect" ADD CONSTRAINT "StoreRedirect_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- One active run per store (same partial-index pattern as ProductMarketPrice).
CREATE UNIQUE INDEX "ImportRun_one_active_per_store" ON "ImportRun"("store_id")
  WHERE "status" IN ('PLANNING', 'QUEUED', 'RUNNING', 'ROLLBACK_QUEUED', 'ROLLING_BACK');
