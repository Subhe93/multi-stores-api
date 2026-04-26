-- CreateEnum
CREATE TYPE "ImportMode" AS ENUM ('AS_IS', 'CUSTOMIZE');

-- CreateEnum
CREATE TYPE "PricingType" AS ENUM ('SINGLE', 'PER_VARIANT', 'MARGIN');

-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "custom_product_id" TEXT;

-- AlterTable
ALTER TABLE "CustomProduct" ADD COLUMN     "import_mode" "ImportMode" NOT NULL DEFAULT 'CUSTOMIZE',
ADD COLUMN     "margin_amount" DECIMAL(10,2),
ADD COLUMN     "pricing_type" "PricingType" NOT NULL DEFAULT 'SINGLE',
ALTER COLUMN "final_price" SET DEFAULT 0;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "custom_product_id" TEXT;

-- AlterTable
ALTER TABLE "PlatformConfig" ADD COLUMN     "default_currency" TEXT NOT NULL DEFAULT 'EUR',
ADD COLUMN     "default_locale" TEXT NOT NULL DEFAULT 'en',
ADD COLUMN     "min_order_amount" DECIMAL(10,2),
ADD COLUMN     "platform_name" TEXT NOT NULL DEFAULT 'Multi Stores',
ADD COLUMN     "require_creator_approval" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "require_provider_approval" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "support_email" TEXT,
ADD COLUMN     "supported_locales" TEXT[] DEFAULT ARRAY['en']::TEXT[],
ALTER COLUMN "commission_value" SET DEFAULT 15;

-- AlterTable
ALTER TABLE "ProductVariant" ADD COLUMN     "compare_at_price" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "CustomProductVariant" (
    "id" TEXT NOT NULL,
    "custom_product_id" TEXT NOT NULL,
    "variant_id" TEXT NOT NULL,
    "custom_price" DECIMAL(10,2),

    CONSTRAINT "CustomProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomProductFieldValue" (
    "id" TEXT NOT NULL,
    "custom_product_id" TEXT NOT NULL,
    "custom_field_id" TEXT NOT NULL,
    "value" TEXT,
    "file_url" TEXT,

    CONSTRAINT "CustomProductFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomProductVariant_custom_product_id_idx" ON "CustomProductVariant"("custom_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "CustomProductVariant_custom_product_id_variant_id_key" ON "CustomProductVariant"("custom_product_id", "variant_id");

-- CreateIndex
CREATE INDEX "CustomProductFieldValue_custom_product_id_idx" ON "CustomProductFieldValue"("custom_product_id");

-- CreateIndex
CREATE UNIQUE INDEX "CustomProductFieldValue_custom_product_id_custom_field_id_key" ON "CustomProductFieldValue"("custom_product_id", "custom_field_id");

-- AddForeignKey
ALTER TABLE "CustomProductVariant" ADD CONSTRAINT "CustomProductVariant_custom_product_id_fkey" FOREIGN KEY ("custom_product_id") REFERENCES "CustomProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomProductVariant" ADD CONSTRAINT "CustomProductVariant_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomProductFieldValue" ADD CONSTRAINT "CustomProductFieldValue_custom_product_id_fkey" FOREIGN KEY ("custom_product_id") REFERENCES "CustomProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomProductFieldValue" ADD CONSTRAINT "CustomProductFieldValue_custom_field_id_fkey" FOREIGN KEY ("custom_field_id") REFERENCES "ProductCustomField"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
