-- Multiple shipping methods per zone (API-CONTRACT-C): a zone now offers a
-- list of selectable methods (delivery / pickup) instead of a single implicit
-- cost. The legacy cost/days columns stay on ShippingZone as the fallback for
-- a zone with no methods; every existing zone gets one "Standard shipping"
-- method copied from them. Orders snapshot the chosen method's id and type
-- next to the already existing shipping_method_name.

-- CreateEnum
CREATE TYPE "ShippingMethodType" AS ENUM ('DELIVERY', 'PICKUP');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "shipping_method_id" TEXT,
ADD COLUMN     "shipping_method_type" "ShippingMethodType";

-- CreateTable
CREATE TABLE "ShippingMethod" (
    "id" TEXT NOT NULL,
    "zone_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "translations" JSONB,
    "type" "ShippingMethodType" NOT NULL DEFAULT 'DELIVERY',
    "base_cost" DECIMAL(10,2) NOT NULL,
    "per_item_cost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "free_threshold" DECIMAL(10,2),
    "estimated_days_min" INTEGER NOT NULL,
    "estimated_days_max" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShippingMethod_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ShippingMethod_zone_id_idx" ON "ShippingMethod"("zone_id");

-- AddForeignKey
ALTER TABLE "ShippingMethod" ADD CONSTRAINT "ShippingMethod_zone_id_fkey" FOREIGN KEY ("zone_id") REFERENCES "ShippingZone"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill: one "Standard shipping" method per existing zone, priced exactly
-- like the zone was, so every store keeps offering what it offered before.
-- gen_random_uuid() is built into PostgreSQL 13+ (no extension needed).
INSERT INTO "ShippingMethod" (
    "id", "zone_id", "name", "type", "base_cost", "per_item_cost",
    "free_threshold", "estimated_days_min", "estimated_days_max",
    "is_active", "sort_order", "created_at"
)
SELECT
    gen_random_uuid()::text, "id", 'Standard shipping', 'DELIVERY',
    "base_cost", "per_item_cost", "free_threshold",
    "estimated_days_min", "estimated_days_max", true, 0, now()
FROM "ShippingZone";
