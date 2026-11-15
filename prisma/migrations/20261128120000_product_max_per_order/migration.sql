-- Per-order quantity limit per product (headless booking B2a). Additive:
-- one nullable column, no default, no backfill; null = unlimited, so every
-- existing product keeps its behaviour. Range 1..9999 is enforced by the API
-- DTOs (no CHECK constraint). Rollback: drop the column.
ALTER TABLE "Product" ADD COLUMN IF NOT EXISTS "max_per_order" INTEGER;
