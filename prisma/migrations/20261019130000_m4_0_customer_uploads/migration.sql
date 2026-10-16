-- M4.0 (platform-wide fix, bug 8): customer uploads keep their exact original
-- bytes in private storage (CustomerUpload.original_key) and expose only a
-- public preview, whose URL stays the value stored in the cart and order.
-- store_id carries no foreign key on purpose (set on first attach, kept after
-- the store is gone, like Order.store_id). OrderCustomFieldValue.upload_id is
-- nullable and SET NULL; rows written before M4.0 have none. Nothing is
-- backfilled.

-- CreateTable
CREATE TABLE "CustomerUpload" (
    "id" TEXT NOT NULL,
    "store_id" TEXT,
    "original_key" TEXT NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "mime" VARCHAR(100) NOT NULL,
    "bytes" INTEGER NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "sha256" CHAR(64) NOT NULL,
    "preview_url" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "attached_at" TIMESTAMP(3),
    "purged_at" TIMESTAMP(3),

    CONSTRAINT "CustomerUpload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomerUpload_attached_at_idx" ON "CustomerUpload"("attached_at");

-- CreateIndex
CREATE INDEX "CustomerUpload_created_at_idx" ON "CustomerUpload"("created_at");

-- CreateIndex
CREATE INDEX "CustomerUpload_store_id_idx" ON "CustomerUpload"("store_id");

-- AlterTable
ALTER TABLE "OrderCustomFieldValue" ADD COLUMN "upload_id" TEXT;

-- CreateIndex
CREATE INDEX "OrderCustomFieldValue_upload_id_idx" ON "OrderCustomFieldValue"("upload_id");

-- AddForeignKey
ALTER TABLE "OrderCustomFieldValue" ADD CONSTRAINT "OrderCustomFieldValue_upload_id_fkey" FOREIGN KEY ("upload_id") REFERENCES "CustomerUpload"("id") ON DELETE SET NULL ON UPDATE CASCADE;
