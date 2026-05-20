-- AlterTable
ALTER TABLE "CartItem" ADD COLUMN     "bundle_offer_id" TEXT;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "bundle_offer_id" TEXT,
ADD COLUMN     "original_unit_price" DECIMAL(10,2);

-- CreateIndex
CREATE INDEX "CartItem_bundle_offer_id_idx" ON "CartItem"("bundle_offer_id");

-- CreateIndex
CREATE INDEX "OrderItem_bundle_offer_id_idx" ON "OrderItem"("bundle_offer_id");

-- AddForeignKey
ALTER TABLE "CartItem" ADD CONSTRAINT "CartItem_bundle_offer_id_fkey" FOREIGN KEY ("bundle_offer_id") REFERENCES "BundleOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_bundle_offer_id_fkey" FOREIGN KEY ("bundle_offer_id") REFERENCES "BundleOffer"("id") ON DELETE SET NULL ON UPDATE CASCADE;
