-- CreateEnum
CREATE TYPE "CreatorCategoryMatchRule" AS ENUM ('MANUAL', 'TAGS');

-- CreateTable
CREATE TABLE "CreatorCategory" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "slug" TEXT NOT NULL,
    "thumbnail_url" TEXT,
    "match_rule" "CreatorCategoryMatchRule" NOT NULL DEFAULT 'MANUAL',
    "match_tags" TEXT[],
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreatorCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreatorCategoryTranslation" (
    "id" TEXT NOT NULL,
    "creator_category_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "CreatorCategoryTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCreatorCategory" (
    "product_id" TEXT NOT NULL,
    "creator_category_id" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductCreatorCategory_pkey" PRIMARY KEY ("product_id","creator_category_id")
);

-- CreateIndex
CREATE INDEX "CreatorCategory_creator_id_parent_id_idx" ON "CreatorCategory"("creator_id", "parent_id");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorCategory_creator_id_slug_key" ON "CreatorCategory"("creator_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "CreatorCategoryTranslation_creator_category_id_locale_key" ON "CreatorCategoryTranslation"("creator_category_id", "locale");

-- CreateIndex
CREATE INDEX "ProductCreatorCategory_creator_category_id_idx" ON "ProductCreatorCategory"("creator_category_id");

-- AddForeignKey
ALTER TABLE "CreatorCategory" ADD CONSTRAINT "CreatorCategory_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorCategory" ADD CONSTRAINT "CreatorCategory_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "CreatorCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreatorCategoryTranslation" ADD CONSTRAINT "CreatorCategoryTranslation_creator_category_id_fkey" FOREIGN KEY ("creator_category_id") REFERENCES "CreatorCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCreatorCategory" ADD CONSTRAINT "ProductCreatorCategory_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCreatorCategory" ADD CONSTRAINT "ProductCreatorCategory_creator_category_id_fkey" FOREIGN KEY ("creator_category_id") REFERENCES "CreatorCategory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
