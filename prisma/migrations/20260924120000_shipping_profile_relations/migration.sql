-- ShippingProfile.provider_id / creator_id had no foreign keys, so deleting a
-- provider or creator (or their user) left orphan profiles behind. Add real
-- relations with ON DELETE CASCADE; zones / methods already cascade from the
-- profile and Product.shipping_profile_id is already ON DELETE SET NULL.

-- Clean existing orphans first so the FKs below cannot fail on a live DB.
-- The Product FK already exists (20260415181451), so this is a no-op guard.
UPDATE "Product"
SET "shipping_profile_id" = NULL
WHERE "shipping_profile_id" IS NOT NULL
  AND "shipping_profile_id" NOT IN (SELECT "id" FROM "ShippingProfile");

DELETE FROM "ShippingProfile"
WHERE ("creator_id" IS NOT NULL AND "creator_id" NOT IN (SELECT "id" FROM "Creator"))
   OR ("provider_id" IS NOT NULL AND "provider_id" NOT IN (SELECT "id" FROM "Provider"));

-- CreateIndex
CREATE INDEX "ShippingProfile_provider_id_idx" ON "ShippingProfile"("provider_id");

-- CreateIndex
CREATE INDEX "ShippingProfile_creator_id_idx" ON "ShippingProfile"("creator_id");

-- AddForeignKey
ALTER TABLE "ShippingProfile" ADD CONSTRAINT "ShippingProfile_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShippingProfile" ADD CONSTRAINT "ShippingProfile_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;
