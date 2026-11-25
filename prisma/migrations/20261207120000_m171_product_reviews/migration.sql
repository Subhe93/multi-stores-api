-- M171: verified-buyer product reviews. Additive only (one enum, two tables);
-- nothing existing is altered.

-- CreateEnum
CREATE TYPE "ProductReviewStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ProductReview" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "product_id" TEXT,
    "custom_product_id" TEXT,
    "customer_id" TEXT NOT NULL,
    "order_id" TEXT,
    "order_item_id" TEXT,
    "verified_purchase" BOOLEAN NOT NULL DEFAULT true,
    "rating" SMALLINT NOT NULL,
    "title" VARCHAR(120),
    "body" TEXT NOT NULL,
    "display_name" VARCHAR(60) NOT NULL,
    "locale" VARCHAR(10) NOT NULL,
    "status" "ProductReviewStatus" NOT NULL DEFAULT 'PENDING',
    "source" VARCHAR(16) NOT NULL DEFAULT 'ACCOUNT',
    "published_at" TIMESTAMP(3),
    "moderated_at" TIMESTAMP(3),
    "moderated_by" TEXT,
    "reply_body" TEXT,
    "replied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductReview_pkey" PRIMARY KEY ("id")
);

-- Raw-SQL constraints (not expressible in the Prisma schema, see
-- prisma/RAW-SQL.md): rating 1..5, and exactly one target (own product XOR
-- custom product).
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_rating_chk"
    CHECK ("rating" BETWEEN 1 AND 5);
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_target_chk"
    CHECK (("product_id" IS NOT NULL) <> ("custom_product_id" IS NOT NULL));

-- CreateIndex
CREATE INDEX "ProductReview_store_id_status_created_at_idx" ON "ProductReview"("store_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "ProductReview_product_id_status_published_at_idx" ON "ProductReview"("product_id", "status", "published_at");

-- CreateIndex
CREATE INDEX "ProductReview_custom_product_id_status_published_at_idx" ON "ProductReview"("custom_product_id", "status", "published_at");

-- CreateIndex
CREATE INDEX "ProductReview_order_id_idx" ON "ProductReview"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReview_customer_id_product_id_key" ON "ProductReview"("customer_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReview_customer_id_custom_product_id_key" ON "ProductReview"("customer_id", "custom_product_id");

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_custom_product_id_fkey" FOREIGN KEY ("custom_product_id") REFERENCES "CustomProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReview" ADD CONSTRAINT "ProductReview_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "OrderItem"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- CreateTable ("moderation required" marker per customer + product)
CREATE TABLE "ProductReviewHold" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "customer_id" TEXT NOT NULL,
    "product_id" TEXT,
    "custom_product_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductReviewHold_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProductReviewHold_store_id_idx" ON "ProductReviewHold"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReviewHold_customer_id_product_id_key" ON "ProductReviewHold"("customer_id", "product_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProductReviewHold_customer_id_custom_product_id_key" ON "ProductReviewHold"("customer_id", "custom_product_id");

-- AddForeignKey
ALTER TABLE "ProductReviewHold" ADD CONSTRAINT "ProductReviewHold_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewHold" ADD CONSTRAINT "ProductReviewHold_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewHold" ADD CONSTRAINT "ProductReviewHold_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductReviewHold" ADD CONSTRAINT "ProductReviewHold_custom_product_id_fkey" FOREIGN KEY ("custom_product_id") REFERENCES "CustomProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
