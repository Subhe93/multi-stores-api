-- Markets app (M1). A market is one country group a store sells to, with its
-- own hostname(s), locales, currency and price rule. Every store gets a
-- default market here (bound to the platform subdomain plus the migrated
-- custom_domain); the rows are inert until the "markets" store app is
-- enabled, so existing stores behave exactly as before.
--
-- Requires PostgreSQL >= 13 (gen_random_uuid() is built in; on older servers
-- install the pgcrypto extension first).

-- CreateEnum
CREATE TYPE "MarketStatus" AS ENUM ('DRAFT', 'LIVE');

-- CreateEnum
CREATE TYPE "StoreDomainStatus" AS ENUM ('PENDING', 'VERIFIED', 'ACTIVE');

-- CreateTable
CREATE TABLE "Market" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "key" VARCHAR(16) NOT NULL,
    "name" TEXT NOT NULL,
    "countries" TEXT[],
    "default_locale" VARCHAR(5) NOT NULL,
    "locales" TEXT[],
    "currency" VARCHAR(3) NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" "MarketStatus" NOT NULL DEFAULT 'DRAFT',
    "price_rule" JSONB NOT NULL DEFAULT '{}',
    "payment_check" JSONB,
    "legal_entity_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Market_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreDomain" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "redirect_to" TEXT,
    "status" "StoreDomainStatus" NOT NULL DEFAULT 'PENDING',
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreDomain_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductMarketPrice" (
    "id" TEXT NOT NULL,
    "market_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "price" DECIMAL(10,2),
    "compare_at_price" DECIMAL(10,2),
    "available" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductMarketPrice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlatformFxRate" (
    "id" TEXT NOT NULL,
    "base" VARCHAR(3) NOT NULL,
    "quote" VARCHAR(3) NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformFxRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Market_store_id_key_key" ON "Market"("store_id", "key");
CREATE INDEX "Market_store_id_idx" ON "Market"("store_id");

CREATE UNIQUE INDEX "StoreDomain_hostname_key" ON "StoreDomain"("hostname");
CREATE INDEX "StoreDomain_store_id_idx" ON "StoreDomain"("store_id");
CREATE INDEX "StoreDomain_market_id_idx" ON "StoreDomain"("market_id");

CREATE UNIQUE INDEX "ProductMarketPrice_market_id_product_id_variant_id_key" ON "ProductMarketPrice"("market_id", "product_id", "variant_id");
CREATE INDEX "ProductMarketPrice_product_id_idx" ON "ProductMarketPrice"("product_id");
-- Postgres treats NULLs as distinct in the unique index above, so the
-- product-level row (variant_id IS NULL) needs its own partial unique index.
CREATE UNIQUE INDEX "ProductMarketPrice_market_product_novariant_key" ON "ProductMarketPrice"("market_id", "product_id") WHERE "variant_id" IS NULL;

CREATE UNIQUE INDEX "PlatformFxRate_base_quote_key" ON "PlatformFxRate"("base", "quote");

-- AddForeignKey
ALTER TABLE "Market" ADD CONSTRAINT "Market_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreDomain" ADD CONSTRAINT "StoreDomain_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "StoreDomain" ADD CONSTRAINT "StoreDomain_market_id_fkey"
    FOREIGN KEY ("market_id") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductMarketPrice" ADD CONSTRAINT "ProductMarketPrice_market_id_fkey"
    FOREIGN KEY ("market_id") REFERENCES "Market"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductMarketPrice" ADD CONSTRAINT "ProductMarketPrice_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductMarketPrice" ADD CONSTRAINT "ProductMarketPrice_variant_id_fkey"
    FOREIGN KEY ("variant_id") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Nullable market columns on existing tables (defaults = today's behaviour).
ALTER TABLE "Order"
    ADD COLUMN "market_id" TEXT,
    ADD COLUMN "hostname" TEXT,
    ADD COLUMN "locale" VARCHAR(10),
    ADD COLUMN "fx_rate_snapshot" DECIMAL(18,8);
CREATE INDEX "Order_market_id_idx" ON "Order"("market_id");
ALTER TABLE "Order" ADD CONSTRAINT "Order_market_id_fkey"
    FOREIGN KEY ("market_id") REFERENCES "Market"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "KustomCheckoutSession"
    ADD COLUMN "market_id" TEXT,
    ADD COLUMN "hostname" TEXT;

-- Backfill (idempotent): one default market per store, LIVE, mirroring the
-- store's language config and currency, plus a StoreDomain row for the legacy
-- custom_domain. Runs for every store regardless of app state — the rows do
-- nothing until the app is enabled.
INSERT INTO "Market"(id, store_id, key, name, countries, default_locale, locales, currency, is_default, status, price_rule, created_at, updated_at)
SELECT gen_random_uuid()::text, s.id, 'default', s.name, '{}', COALESCE(lc.primary_locale, 'en'), COALESCE(lc.secondary_locales, '{}'),
       COALESCE(s.currency, 'EUR'), true, 'LIVE', '{"mode":"convert","source":"manual","rate":1}', now(), now()
FROM "Store" s LEFT JOIN "StoreLanguageConfig" lc ON lc.store_id = s.id
WHERE NOT EXISTS (SELECT 1 FROM "Market" m WHERE m.store_id = s.id AND m.is_default);

INSERT INTO "StoreDomain"(id, store_id, market_id, hostname, is_primary, status, verified_at, created_at)
SELECT gen_random_uuid()::text, s.id, m.id, lower(s.custom_domain), true, 'ACTIVE', now(), now()
FROM "Store" s JOIN "Market" m ON m.store_id = s.id AND m.is_default
WHERE s.custom_domain IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM "StoreDomain" d WHERE d.hostname = lower(s.custom_domain));
