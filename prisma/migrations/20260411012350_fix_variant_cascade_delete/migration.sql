-- DropForeignKey
ALTER TABLE "CustomProductVariant" DROP CONSTRAINT "CustomProductVariant_variant_id_fkey";

-- AddForeignKey
ALTER TABLE "CustomProductVariant" ADD CONSTRAINT "CustomProductVariant_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "ProductVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
