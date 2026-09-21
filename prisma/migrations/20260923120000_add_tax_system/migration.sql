-- Tax system (plans/tax-system/API-CONTRACT-TAX.md): tax classes + a
-- destination rate table (platform and per-store rows), per-store tax
-- settings, per-product class / exemption, and itemized tax snapshots on
-- orders and order items. The legacy single-rate columns
-- (Store.tax_rate_bp, PlatformConfig.default_tax_rate_bp) stay in place but
-- are converted into TaxRate rows below and are no longer written.

-- CreateEnum
CREATE TYPE "TaxPricingMode" AS ENUM ('INCLUSIVE', 'EXCLUSIVE');

-- CreateEnum
CREATE TYPE "TaxBasis" AS ENUM ('SHIPPING', 'BILLING', 'STORE');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "tax_class_id" TEXT,
ADD COLUMN     "tax_exempt" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "tax_pricing_mode" "TaxPricingMode" NOT NULL DEFAULT 'INCLUSIVE',
ADD COLUMN     "tax_basis_country" VARCHAR(2),
ADD COLUMN     "tax_lines" JSONB,
ADD COLUMN     "shipping_tax_rate_bp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "shipping_tax_amount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "tax_class_key" TEXT,
ADD COLUMN     "tax_rate_bp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tax_amount" DECIMAL(10,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "PlatformConfig" ADD COLUMN     "default_tax_pricing_mode" "TaxPricingMode" NOT NULL DEFAULT 'INCLUSIVE',
ADD COLUMN     "platform_tax_country" VARCHAR(2),
ADD COLUMN     "platform_oss_registered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tax_rates_seeded_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "tax_pricing_mode" "TaxPricingMode" NOT NULL DEFAULT 'INCLUSIVE',
ADD COLUMN     "tax_basis" "TaxBasis" NOT NULL DEFAULT 'SHIPPING',
ADD COLUMN     "tax_country" VARCHAR(2),
ADD COLUMN     "oss_registered" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "use_platform_tax_rates" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "shipping_tax_class_id" TEXT,
ADD COLUMN     "display_prices_incl_tax" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable: the Kustom session keeps the reported region / postcode next to
-- the country so its re-pricing and the order created at validation resolve
-- the same regional rates.
ALTER TABLE "KustomCheckoutSession" ADD COLUMN     "region" TEXT,
ADD COLUMN     "postcode" TEXT;

-- CreateTable
CREATE TABLE "TaxClass" (
    "id" TEXT NOT NULL,
    "store_id" TEXT,
    "key" TEXT NOT NULL,
    "name" JSONB NOT NULL,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxClass_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxRate" (
    "id" TEXT NOT NULL,
    "store_id" TEXT,
    "tax_class_id" TEXT NOT NULL,
    "country" VARCHAR(2) NOT NULL,
    "region" TEXT,
    "postcode_pattern" TEXT,
    "rate_bp" INTEGER NOT NULL,
    "label" JSONB NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "applies_to_shipping" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxRate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TaxClass_store_id_key_key" ON "TaxClass"("store_id", "key");

-- CreateIndex
CREATE INDEX "TaxRate_country_tax_class_id_idx" ON "TaxRate"("country", "tax_class_id");

-- CreateIndex
CREATE INDEX "TaxRate_store_id_idx" ON "TaxRate"("store_id");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_tax_class_id_fkey" FOREIGN KEY ("tax_class_id") REFERENCES "TaxClass"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxClass" ADD CONSTRAINT "TaxClass_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxRate" ADD CONSTRAINT "TaxRate_tax_class_id_fkey" FOREIGN KEY ("tax_class_id") REFERENCES "TaxClass"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────
-- Data
-- ─────────────────────────────────────────────────────────────────────────

-- 1. Platform tax classes: standard (default), reduced, zero.
-- gen_random_uuid() is built into PostgreSQL 13+ (no extension needed).
INSERT INTO "TaxClass" ("id", "store_id", "key", "name", "is_default", "sort_order", "created_at")
VALUES
  (gen_random_uuid()::text, NULL, 'standard',
   '{"en":"Standard","sv":"Standard","de":"Standard","fr":"Standard","tr":"Standart","ar":"قياسية"}'::jsonb,
   true, 0, now()),
  (gen_random_uuid()::text, NULL, 'reduced',
   '{"en":"Reduced","sv":"Reducerad","de":"Ermäßigt","fr":"Réduit","tr":"İndirimli","ar":"مخفضة"}'::jsonb,
   false, 1, now()),
  (gen_random_uuid()::text, NULL, 'zero',
   '{"en":"Zero","sv":"Noll","de":"Null","fr":"Zéro","tr":"Sıfır","ar":"صفرية"}'::jsonb,
   false, 2, now());

-- 2. The legacy platform-wide VAT rate becomes one platform TaxRate on the
-- standard class for the platform's registration country (SE when unset).
-- The platform registration country is set to SE in the same step so the
-- converted rate actually resolves for marketplace orders.
UPDATE "PlatformConfig"
SET "platform_tax_country" = 'SE'
WHERE "platform_tax_country" IS NULL AND "default_tax_rate_bp" > 0;

INSERT INTO "TaxRate" (
    "id", "store_id", "tax_class_id", "country", "region", "postcode_pattern",
    "rate_bp", "label", "priority", "applies_to_shipping", "is_active", "created_at"
)
SELECT
    gen_random_uuid()::text, NULL, c."id", COALESCE(p."platform_tax_country", 'SE'), NULL, NULL,
    p."default_tax_rate_bp",
    '{"en":"VAT","sv":"Moms","de":"MwSt.","fr":"TVA","tr":"KDV","ar":"ضريبة القيمة المضافة"}'::jsonb,
    0, true, true, now()
FROM "PlatformConfig" p
CROSS JOIN "TaxClass" c
WHERE c."store_id" IS NULL AND c."key" = 'standard' AND p."default_tax_rate_bp" > 0
LIMIT 1;

-- 3. Every store with its own VAT override gets one store TaxRate on the
-- platform standard class and stops using the platform rates (the override
-- replaced them completely before). Stores priced in SEK register in SE,
-- and so does every store that receives a converted rate (whatever its
-- currency): the rate row below is created for COALESCE(tax_country, 'SE'),
-- and a store rate only ever resolves when the registration country is the
-- rate's country, so the two must be set together.
UPDATE "Store" s
SET "tax_country" = 'SE'
WHERE s."tax_country" IS NULL
  AND (
    (s."tax_rate_bp" IS NOT NULL AND s."tax_rate_bp" > 0)
    OR s."currency" = 'SEK'
    OR (s."currency" IS NULL AND EXISTS (
      SELECT 1 FROM "PlatformConfig" p WHERE p."default_currency" = 'SEK'
    ))
  );

INSERT INTO "TaxRate" (
    "id", "store_id", "tax_class_id", "country", "region", "postcode_pattern",
    "rate_bp", "label", "priority", "applies_to_shipping", "is_active", "created_at"
)
SELECT
    gen_random_uuid()::text, s."id", c."id", COALESCE(s."tax_country", 'SE'), NULL, NULL,
    s."tax_rate_bp",
    '{"en":"VAT","sv":"Moms","de":"MwSt.","fr":"TVA","tr":"KDV","ar":"ضريبة القيمة المضافة"}'::jsonb,
    0, true, true, now()
FROM "Store" s
CROSS JOIN "TaxClass" c
WHERE c."store_id" IS NULL AND c."key" = 'standard'
  AND s."tax_rate_bp" IS NOT NULL AND s."tax_rate_bp" > 0;

UPDATE "Store"
SET "use_platform_tax_rates" = false
WHERE "tax_rate_bp" IS NOT NULL AND "tax_rate_bp" > 0;

-- 4. Existing orders: one VAT tax line from the legacy snapshot columns.
UPDATE "Order"
SET "tax_lines" = jsonb_build_array(
    jsonb_build_object(
        'label', 'VAT',
        'rate_bp', "tax_rate_bp",
        'taxable_amount', ("total" - "tax_amount"),
        'tax_amount', "tax_amount"
    )
)
WHERE "tax_amount" > 0 AND "tax_lines" IS NULL;
