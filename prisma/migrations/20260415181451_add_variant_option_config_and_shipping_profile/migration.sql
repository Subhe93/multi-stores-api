-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "shipping_profile_id" TEXT,
ADD COLUMN     "variant_option_config" JSONB;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_shipping_profile_id_fkey" FOREIGN KEY ("shipping_profile_id") REFERENCES "ShippingProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;
