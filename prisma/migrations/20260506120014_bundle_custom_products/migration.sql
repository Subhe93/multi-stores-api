-- CreateTable
CREATE TABLE "BundleCustomProduct" (
    "bundle_id" TEXT NOT NULL,
    "custom_product_id" TEXT NOT NULL,

    CONSTRAINT "BundleCustomProduct_pkey" PRIMARY KEY ("bundle_id","custom_product_id")
);

-- CreateIndex
CREATE INDEX "BundleCustomProduct_custom_product_id_idx" ON "BundleCustomProduct"("custom_product_id");

-- AddForeignKey
ALTER TABLE "BundleCustomProduct" ADD CONSTRAINT "BundleCustomProduct_bundle_id_fkey" FOREIGN KEY ("bundle_id") REFERENCES "Bundle"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BundleCustomProduct" ADD CONSTRAINT "BundleCustomProduct_custom_product_id_fkey" FOREIGN KEY ("custom_product_id") REFERENCES "CustomProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;
