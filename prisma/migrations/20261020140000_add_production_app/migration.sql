-- Production app (M4.3). Per-line production checks, a denormalised
-- per-order summary (server-side orders-list filter) and an append-only
-- audit trail. store_id carries no foreign key on purpose (like
-- Invoice.store_id); order/order item rows cascade. Nothing is backfilled:
-- stores without the app never get rows.

-- CreateEnum
CREATE TYPE "ProductionCheckSource" AS ENUM ('FIELD_VALUE', 'VARIANT_OPTION', 'DESIGN', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ProductionState" AS ENUM ('NONE', 'NOT_STARTED', 'IN_PROGRESS', 'READY');

-- CreateTable
CREATE TABLE "OrderProductionCheck" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "source" "ProductionCheckSource" NOT NULL,
    "source_key" VARCHAR(160) NOT NULL,
    "source_hash" VARCHAR(64),
    "label" TEXT NOT NULL,
    "value" TEXT,
    "group_index" INTEGER,
    "file_url" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "done_at" TIMESTAMP(3),
    "done_by" TEXT,
    "done_by_name" TEXT,
    "stale" BOOLEAN NOT NULL DEFAULT false,
    "created_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderProductionCheck_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderProductionSummary" (
    "order_id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "state" "ProductionState" NOT NULL DEFAULT 'NONE',
    "completed_at" TIMESTAMP(3),
    "synced_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderProductionSummary_pkey" PRIMARY KEY ("order_id")
);

-- CreateTable
CREATE TABLE "OrderProductionEvent" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "check_id" TEXT,
    "action" VARCHAR(24) NOT NULL,
    "actor_id" TEXT,
    "actor_name" TEXT,
    "payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderProductionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrderProductionCheck_order_item_id_source_key_key" ON "OrderProductionCheck"("order_item_id", "source_key");

-- CreateIndex
CREATE INDEX "OrderProductionCheck_order_id_idx" ON "OrderProductionCheck"("order_id");

-- CreateIndex
CREATE INDEX "OrderProductionCheck_store_id_idx" ON "OrderProductionCheck"("store_id");

-- CreateIndex
CREATE INDEX "OrderProductionSummary_store_id_state_idx" ON "OrderProductionSummary"("store_id", "state");

-- CreateIndex
CREATE INDEX "OrderProductionEvent_order_id_created_at_idx" ON "OrderProductionEvent"("order_id", "created_at");

-- AddForeignKey
ALTER TABLE "OrderProductionCheck" ADD CONSTRAINT "OrderProductionCheck_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderProductionCheck" ADD CONSTRAINT "OrderProductionCheck_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderProductionSummary" ADD CONSTRAINT "OrderProductionSummary_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderProductionEvent" ADD CONSTRAINT "OrderProductionEvent_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
