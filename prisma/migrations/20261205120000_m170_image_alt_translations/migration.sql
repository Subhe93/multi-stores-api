-- M170 A: per-locale alt text of a product image. Additive, nullable, no
-- backfill, no rewrite. Old code never reads or writes the column.
-- Rollback: ALTER TABLE "ProductImage" DROP COLUMN IF EXISTS "alt_translations";
ALTER TABLE "ProductImage" ADD COLUMN IF NOT EXISTS "alt_translations" JSONB;
