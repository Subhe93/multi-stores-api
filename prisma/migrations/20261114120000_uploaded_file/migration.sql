-- Upload ownership (plans/security-hardening AUDIT-2026-11-04 M1). Hand-written.
-- One row per public file stored through UploadsService: who uploaded it and,
-- for creators, from which store. DELETE /uploads/:url checks this row;
-- files stored before this migration have none and keep the reference check.

-- CreateTable
CREATE TABLE "UploadedFile" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "user_id" TEXT,
    "store_id" TEXT,
    "folder" TEXT NOT NULL,
    "size" INTEGER NOT NULL,
    "content_type" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UploadedFile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "UploadedFile_key_key" ON "UploadedFile"("key");

-- CreateIndex
CREATE INDEX "UploadedFile_user_id_idx" ON "UploadedFile"("user_id");

-- CreateIndex
CREATE INDEX "UploadedFile_store_id_idx" ON "UploadedFile"("store_id");

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UploadedFile" ADD CONSTRAINT "UploadedFile_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
