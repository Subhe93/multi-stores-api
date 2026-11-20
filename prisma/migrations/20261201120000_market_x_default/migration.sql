-- Configurable hreflang x-default market. Additive: one boolean column,
-- NOT NULL DEFAULT false, so every existing market reads "not chosen" and
-- the x-default stays the default market until an owner picks another one.
-- The constant default needs no table rewrite and no backfill.
-- At most one chosen market per store, enforced by a partial unique index
-- (Prisma cannot express it in the schema; same pattern as
-- "ProductMarketPrice_market_product_novariant_key").
-- Rollback: drop the index, then the column.
ALTER TABLE "Market" ADD COLUMN IF NOT EXISTS "is_x_default" BOOLEAN NOT NULL DEFAULT false;
CREATE UNIQUE INDEX IF NOT EXISTS "Market_store_x_default_key" ON "Market"("store_id") WHERE "is_x_default";
