-- M170 C: store-level return policy + handling time for structured data.
-- Additive, nullable, no backfill, no rewrite. NULL = not configured.
-- Rollback: ALTER TABLE "Store" DROP COLUMN IF EXISTS "merchant_policies";
ALTER TABLE "Store" ADD COLUMN IF NOT EXISTS "merchant_policies" JSONB;
