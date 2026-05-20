-- CreateTable
CREATE TABLE "CustomProductCreatorCategory" (
    "custom_product_id" TEXT NOT NULL,
    "creator_category_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CustomProductCreatorCategory_pkey" PRIMARY KEY ("custom_product_id","creator_category_id")
);

-- CreateIndex
CREATE INDEX "CustomProductCreatorCategory_creator_category_id_idx" ON "CustomProductCreatorCategory"("creator_category_id");

-- AddForeignKey
ALTER TABLE "CustomProductCreatorCategory" ADD CONSTRAINT "CustomProductCreatorCategory_custom_product_id_fkey" FOREIGN KEY ("custom_product_id") REFERENCES "CustomProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomProductCreatorCategory" ADD CONSTRAINT "CustomProductCreatorCategory_creator_category_id_fkey" FOREIGN KEY ("creator_category_id") REFERENCES "CreatorCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
