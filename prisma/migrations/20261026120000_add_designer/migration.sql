-- Designer store app (M4.2) — migration #7 in the global M4 order
-- (M4-INTEGRATION §1.6). Hand-written from the M4.2 design (§2).
-- Additive only: six new tables and four enums; the single change to an
-- existing table is the nullable "CartItem"."design_id" (+ index, no FK, so a
-- purged draft never cascades into cart rows). Nothing is backfilled.

-- CreateEnum
CREATE TYPE "DesignTemplateStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "DesignAssetKind" AS ENUM ('CUSTOMER_PHOTO', 'TEMPLATE_BG_WEB', 'TEMPLATE_BG_PRINT', 'TEMPLATE_DECO', 'TEMPLATE_THUMB', 'FONT');

-- CreateEnum
CREATE TYPE "DesignStatus" AS ENUM ('DRAFT', 'IN_CART', 'ORDERED');

-- CreateEnum
CREATE TYPE "DesignPrintStatus" AS ENUM ('PENDING', 'RENDERING', 'READY', 'FAILED', 'PURGED');

-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "design_id" TEXT;

-- CreateTable
CREATE TABLE "DesignTemplate" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "status" "DesignTemplateStatus" NOT NULL DEFAULT 'DRAFT',
    "current_version_id" TEXT,
    "source" VARCHAR(16) NOT NULL DEFAULT 'native',
    "external_ref" VARCHAR(191),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesignTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignTemplateVersion" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "spec" JSONB NOT NULL,
    "spec_sha256" VARCHAR(64) NOT NULL,
    "thumbnail_url" TEXT,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignTemplateVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductDesigner" (
    "product_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "addons" JSONB NOT NULL DEFAULT '{}',
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductDesigner_pkey" PRIMARY KEY ("product_id")
);

-- CreateTable
CREATE TABLE "DesignAsset" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "kind" "DesignAssetKind" NOT NULL,
    "design_id" TEXT,
    "private_key" TEXT,
    "preview_key" TEXT,
    "public_url" TEXT,
    "mime" VARCHAR(32) NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "meta" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "purged_at" TIMESTAMP(3),

    CONSTRAINT "DesignAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Design" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "template_version_id" TEXT NOT NULL,
    "state" JSONB NOT NULL,
    "state_version" INTEGER NOT NULL DEFAULT 1,
    "status" "DesignStatus" NOT NULL DEFAULT 'DRAFT',
    "customer_id" TEXT,
    "access_token_hash" VARCHAR(64) NOT NULL,
    "proof_key" TEXT,
    "proof_state_sha" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Design_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderItemDesign" (
    "id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "design_id" TEXT,
    "template_id" TEXT NOT NULL,
    "template_version_id" TEXT NOT NULL,
    "template_spec" JSONB NOT NULL,
    "state" JSONB NOT NULL,
    "assets" JSONB NOT NULL,
    "text_values" JSONB NOT NULL,
    "price_breakdown" JSONB NOT NULL,
    "renderer_version" VARCHAR(16) NOT NULL,
    "proof_key" TEXT,
    "print_status" "DesignPrintStatus" NOT NULL DEFAULT 'PENDING',
    "print_attempts" INTEGER NOT NULL DEFAULT 0,
    "print_next_attempt_at" TIMESTAMP(3),
    "print_locked_at" TIMESTAMP(3),
    "print_error" TEXT,
    "print_files" JSONB,
    "print_rendered_at" TIMESTAMP(3),
    "print_requested_at" TIMESTAMP(3),
    "shipped_at" TIMESTAMP(3),
    "terminal_at" TIMESTAMP(3),
    "originals_purged_at" TIMESTAMP(3),
    "files_purged_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderItemDesign_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DesignTemplate_store_id_status_idx" ON "DesignTemplate"("store_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DesignTemplate_store_id_source_external_ref_key" ON "DesignTemplate"("store_id", "source", "external_ref");

-- CreateIndex
CREATE UNIQUE INDEX "DesignTemplateVersion_template_id_version_key" ON "DesignTemplateVersion"("template_id", "version");

-- CreateIndex
CREATE INDEX "ProductDesigner_store_id_idx" ON "ProductDesigner"("store_id");

-- CreateIndex
CREATE INDEX "ProductDesigner_template_id_idx" ON "ProductDesigner"("template_id");

-- CreateIndex
CREATE INDEX "DesignAsset_store_id_kind_idx" ON "DesignAsset"("store_id", "kind");

-- CreateIndex
CREATE INDEX "DesignAsset_design_id_idx" ON "DesignAsset"("design_id");

-- CreateIndex
CREATE INDEX "DesignAsset_kind_created_at_idx" ON "DesignAsset"("kind", "created_at");

-- CreateIndex
CREATE INDEX "Design_store_id_status_updated_at_idx" ON "Design"("store_id", "status", "updated_at");

-- CreateIndex
CREATE INDEX "Design_customer_id_idx" ON "Design"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "OrderItemDesign_order_item_id_key" ON "OrderItemDesign"("order_item_id");

-- CreateIndex
CREATE INDEX "OrderItemDesign_store_id_print_status_idx" ON "OrderItemDesign"("store_id", "print_status");

-- CreateIndex
CREATE INDEX "OrderItemDesign_print_status_print_next_attempt_at_idx" ON "OrderItemDesign"("print_status", "print_next_attempt_at");

-- CreateIndex
CREATE INDEX "OrderItemDesign_order_id_idx" ON "OrderItemDesign"("order_id");

-- CreateIndex
CREATE INDEX "CartItem_design_id_idx" ON "CartItem"("design_id");

-- AddForeignKey
ALTER TABLE "DesignTemplate" ADD CONSTRAINT "DesignTemplate_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignTemplateVersion" ADD CONSTRAINT "DesignTemplateVersion_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "DesignTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductDesigner" ADD CONSTRAINT "ProductDesigner_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductDesigner" ADD CONSTRAINT "ProductDesigner_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "DesignTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignAsset" ADD CONSTRAINT "DesignAsset_design_id_fkey" FOREIGN KEY ("design_id") REFERENCES "Design"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Design" ADD CONSTRAINT "Design_template_version_id_fkey" FOREIGN KEY ("template_version_id") REFERENCES "DesignTemplateVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItemDesign" ADD CONSTRAINT "OrderItemDesign_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

