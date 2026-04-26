-- CreateEnum
CREATE TYPE "PromotionType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT', 'BUY_X_GET_Y', 'BUNDLE', 'QUANTITY_DISCOUNT', 'FREE_SHIPPING', 'COUPON', 'FLASH_SALE');

-- CreateEnum
CREATE TYPE "PromotionLevel" AS ENUM ('PROVIDER_TO_CREATOR', 'CREATOR_TO_CUSTOMER');

-- CreateEnum
CREATE TYPE "PromotionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'DISABLED');

-- CreateTable
CREATE TABLE "Promotion" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT,
    "creator_id" TEXT,
    "type" "PromotionType" NOT NULL,
    "level" "PromotionLevel" NOT NULL,
    "value" DECIMAL(10,2) NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "coupon_code" TEXT,
    "usage_limit" INTEGER,
    "usage_count" INTEGER NOT NULL DEFAULT 0,
    "starts_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "status" "PromotionStatus" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Promotion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionTranslation" (
    "id" TEXT NOT NULL,
    "promotion_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "PromotionTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromotionUsage" (
    "id" TEXT NOT NULL,
    "promotion_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "discount_amount" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromotionUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Promotion_coupon_code_key" ON "Promotion"("coupon_code");

-- CreateIndex
CREATE INDEX "Promotion_coupon_code_idx" ON "Promotion"("coupon_code");

-- CreateIndex
CREATE INDEX "Promotion_status_idx" ON "Promotion"("status");

-- CreateIndex
CREATE INDEX "Promotion_level_idx" ON "Promotion"("level");

-- CreateIndex
CREATE UNIQUE INDEX "PromotionTranslation_promotion_id_locale_key" ON "PromotionTranslation"("promotion_id", "locale");

-- CreateIndex
CREATE INDEX "PromotionUsage_promotion_id_idx" ON "PromotionUsage"("promotion_id");

-- CreateIndex
CREATE INDEX "PromotionUsage_order_id_idx" ON "PromotionUsage"("order_id");

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Promotion" ADD CONSTRAINT "Promotion_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "Creator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionTranslation" ADD CONSTRAINT "PromotionTranslation_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "Promotion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionUsage" ADD CONSTRAINT "PromotionUsage_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "Promotion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromotionUsage" ADD CONSTRAINT "PromotionUsage_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
