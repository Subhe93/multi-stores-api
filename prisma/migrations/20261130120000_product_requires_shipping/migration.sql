-- Products that need no shipping (services / digital products), like
-- Shopify's "Physical product" setting. Additive: three boolean columns,
-- NOT NULL DEFAULT true, so every existing product, order line and order
-- reads "requires shipping" and nothing changes until an owner switches a
-- product off. The constant default needs no table rewrite and no backfill.
-- OrderItem / Order hold the value as sold (snapshot), never re-derived.
-- Rollback: drop the three columns.
ALTER TABLE "Product"   ADD COLUMN IF NOT EXISTS "requires_shipping" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "OrderItem" ADD COLUMN IF NOT EXISTS "requires_shipping" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Order"     ADD COLUMN IF NOT EXISTS "requires_shipping" BOOLEAN NOT NULL DEFAULT true;
