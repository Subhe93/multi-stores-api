-- Order trash (soft delete). deleted_at / deleted_by are null for live orders;
-- a deleted order stays in the table (bookkeeping) and only appears in the
-- dashboard "Deleted" tab, from where it can be restored. Additive, no backfill.
ALTER TABLE "Order" ADD COLUMN "deleted_at" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "deleted_by" TEXT;

-- The Deleted tab lists only trashed orders of one store: partial index.
CREATE INDEX "Order_store_id_deleted_at_idx" ON "Order"("store_id") WHERE "deleted_at" IS NOT NULL;

-- The admin Deleted tab lists trashed orders across stores.
CREATE INDEX "Order_deleted_at_idx" ON "Order"("deleted_at") WHERE "deleted_at" IS NOT NULL;
