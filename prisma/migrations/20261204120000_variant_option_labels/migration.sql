-- M159: display labels of variant option names/values per locale, and the
-- buyer-locale display snapshot of an order line. Additive, nullable, no
-- backfill, no rewrite.
-- Rollback: ALTER TABLE "ProductTranslation" DROP COLUMN IF EXISTS "variant_option_labels";
--           ALTER TABLE "OrderItem" DROP COLUMN IF EXISTS "variant_options_display";
ALTER TABLE "ProductTranslation" ADD COLUMN IF NOT EXISTS "variant_option_labels" JSONB;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "variant_options_display" JSONB;
