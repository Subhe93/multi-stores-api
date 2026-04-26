-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderItem" ADD CONSTRAINT "OrderItem_custom_product_id_fkey" FOREIGN KEY ("custom_product_id") REFERENCES "CustomProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;
