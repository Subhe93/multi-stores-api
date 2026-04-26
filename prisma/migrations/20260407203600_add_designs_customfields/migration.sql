-- CreateEnum
CREATE TYPE "DesignStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('TEXT', 'TEXTAREA', 'NUMBER', 'IMAGE', 'FILE', 'SELECT', 'COLOR', 'FONT', 'DATE', 'MULTI_IMAGE');

-- CreateTable
CREATE TABLE "Design" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "status" "DesignStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "tags" TEXT[],

    CONSTRAINT "Design_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignTranslation" (
    "id" TEXT NOT NULL,
    "design_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "DesignTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignFile" (
    "id" TEXT NOT NULL,
    "design_id" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "is_preview" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "DesignFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomProduct" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "design_id" TEXT,
    "creator_id" TEXT NOT NULL,
    "final_price" DECIMAL(10,2) NOT NULL,
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomProductImage" (
    "id" TEXT NOT NULL,
    "custom_product_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CustomProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomProductTranslation" (
    "id" TEXT NOT NULL,
    "custom_product_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "slug" TEXT NOT NULL,

    CONSTRAINT "CustomProductTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductCustomField" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "CustomFieldType" NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "placeholder" TEXT,
    "options" JSONB,
    "validation_rules" JSONB,
    "linked_validation" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductCustomField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldTranslation" (
    "id" TEXT NOT NULL,
    "field_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "label" TEXT NOT NULL,
    "placeholder" TEXT,
    "option_labels" JSONB,

    CONSTRAINT "CustomFieldTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderCustomFieldValue" (
    "id" TEXT NOT NULL,
    "order_item_id" TEXT NOT NULL,
    "custom_field_id" TEXT NOT NULL,
    "value" TEXT,
    "file_url" TEXT,

    CONSTRAINT "OrderCustomFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DesignTranslation_design_id_locale_key" ON "DesignTranslation"("design_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "CustomProductTranslation_custom_product_id_locale_key" ON "CustomProductTranslation"("custom_product_id", "locale");

-- CreateIndex
CREATE INDEX "ProductCustomField_product_id_idx" ON "ProductCustomField"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldTranslation_field_id_locale_key" ON "CustomFieldTranslation"("field_id", "locale");

-- CreateIndex
CREATE INDEX "OrderCustomFieldValue_order_item_id_idx" ON "OrderCustomFieldValue"("order_item_id");

-- AddForeignKey
ALTER TABLE "Design" ADD CONSTRAINT "Design_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignTranslation" ADD CONSTRAINT "DesignTranslation_design_id_fkey" FOREIGN KEY ("design_id") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignFile" ADD CONSTRAINT "DesignFile_design_id_fkey" FOREIGN KEY ("design_id") REFERENCES "Design"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomProduct" ADD CONSTRAINT "CustomProduct_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomProduct" ADD CONSTRAINT "CustomProduct_design_id_fkey" FOREIGN KEY ("design_id") REFERENCES "Design"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomProduct" ADD CONSTRAINT "CustomProduct_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "Creator"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomProductImage" ADD CONSTRAINT "CustomProductImage_custom_product_id_fkey" FOREIGN KEY ("custom_product_id") REFERENCES "CustomProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomProductTranslation" ADD CONSTRAINT "CustomProductTranslation_custom_product_id_fkey" FOREIGN KEY ("custom_product_id") REFERENCES "CustomProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCustomField" ADD CONSTRAINT "ProductCustomField_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldTranslation" ADD CONSTRAINT "CustomFieldTranslation_field_id_fkey" FOREIGN KEY ("field_id") REFERENCES "ProductCustomField"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCustomFieldValue" ADD CONSTRAINT "OrderCustomFieldValue_order_item_id_fkey" FOREIGN KEY ("order_item_id") REFERENCES "OrderItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderCustomFieldValue" ADD CONSTRAINT "OrderCustomFieldValue_custom_field_id_fkey" FOREIGN KEY ("custom_field_id") REFERENCES "ProductCustomField"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
