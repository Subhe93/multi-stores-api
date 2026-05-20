-- CreateEnum
CREATE TYPE "BundleDiscountType" AS ENUM ('ITEM', 'PERCENTAGE', 'FIXED');

-- CreateEnum
CREATE TYPE "BundleStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateTable
CREATE TABLE "Bundle" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "status" "BundleStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bundle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleTranslation" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "BundleTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleOffer" (
    "id" TEXT NOT NULL,
    "bundle_id" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "discount_type" "BundleDiscountType" NOT NULL,
    "discount_value" DECIMAL(10,2) NOT NULL,
    "external_ref" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BundleOffer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleOfferTranslation" (
    "id" TEXT NOT NULL,
    "offer_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "title" TEXT NOT NULL,
    "label" TEXT,
    "sticker_text" TEXT,

    CONSTRAINT "BundleOfferTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BundleProduct" (
    "bundle_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,

    CONSTRAINT "BundleProduct_pkey" PRIMARY KEY ("bundle_id","product_id")
);

-- CreateIndex
CREATE INDEX "Bundle_creator_id_idx" ON "Bundle"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "BundleTranslation_bundle_id_locale_key" ON "BundleTranslation"("bundle_id", "locale");

-- CreateIndex
CREATE INDEX "BundleOffer_bundle_id_idx" ON "BundleOffer"("bundle_id");

-- CreateIndex
CREATE UNIQUE INDEX "BundleOfferTranslation_offer_id_locale_key" ON "BundleOfferTranslation"("offer_id", "locale");

-- CreateIndex
CREATE INDEX "BundleProduct_product_id_idx" ON "BundleProduct"("product_id");

-- AddForeignKey
ALTER TABLE "Bundle" ADD CONSTRAINT "Bundle_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleTranslation" ADD CONSTRAINT "BundleTranslation_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "Bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleOffer" ADD CONSTRAINT "BundleOffer_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "Bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleOfferTranslation" ADD CONSTRAINT "BundleOfferTranslation_offer_id_fkey" FOREIGN KEY ("offer_id") REFERENCES "BundleOffer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleProduct" ADD CONSTRAINT "BundleProduct_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "Bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleProduct" ADD CONSTRAINT "BundleProduct_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
