-- CreateEnum
CREATE TYPE "AttributeType" AS ENUM ('TEXT', 'NUMBER', 'SELECT', 'MULTI_SELECT', 'BOOLEAN', 'COLOR', 'DIMENSIONS');

-- CreateEnum
CREATE TYPE "ProductType" AS ENUM ('TRADITIONAL', 'CUSTOMIZABLE');

-- CreateEnum
CREATE TYPE "CustomizationType" AS ENUM ('PRINT', 'ENGRAVE', 'PRINT_3D', 'EMBROIDERY', 'HANDMADE', 'HEAT_PRESS', 'SCREEN_PRINT', 'UV_PRINT', 'CNC', 'OTHER');

-- CreateEnum
CREATE TYPE "ProductStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "parent_id" TEXT,
    "slug" TEXT NOT NULL,
    "icon" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryTranslation" (
    "id" TEXT NOT NULL,
    "category_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "CategoryTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeTemplate" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" "AttributeType" NOT NULL,
    "unit" TEXT,
    "options" JSONB,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "group_name" TEXT,
    "validation_rules" JSONB,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "AttributeTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AttributeTemplateTranslation" (
    "id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "label" TEXT NOT NULL,
    "option_labels" JSONB,

    CONSTRAINT "AttributeTemplateTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CategoryAttributeTemplate" (
    "category_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,

    CONSTRAINT "CategoryAttributeTemplate_pkey" PRIMARY KEY ("category_id","template_id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "provider_id" TEXT,
    "creator_id" TEXT,
    "category_id" TEXT NOT NULL,
    "product_type" "ProductType" NOT NULL,
    "customization_type" "CustomizationType",
    "base_price" DECIMAL(10,2) NOT NULL,
    "compare_at_price" DECIMAL(10,2),
    "cost_price" DECIMAL(10,2),
    "sku" TEXT,
    "track_inventory" BOOLEAN NOT NULL DEFAULT false,
    "stock_quantity" INTEGER,
    "weight" DECIMAL(8,2),
    "weight_unit" TEXT DEFAULT 'kg',
    "status" "ProductStatus" NOT NULL DEFAULT 'DRAFT',
    "is_featured" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductTranslation" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "meta_title" TEXT,
    "meta_desc" TEXT,

    CONSTRAINT "ProductTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductImage" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "variant_id" TEXT,
    "url" TEXT NOT NULL,
    "alt_text" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductAttribute" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "template_id" TEXT NOT NULL,
    "value" JSONB NOT NULL,

    CONSTRAINT "ProductAttribute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductTag" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "tag" TEXT NOT NULL,

    CONSTRAINT "ProductTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductVariant" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "sku" TEXT,
    "price_adjustment" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "stock_quantity" INTEGER,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "options" JSONB NOT NULL,

    CONSTRAINT "ProductVariant_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Category_slug_key" ON "Category"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "CategoryTranslation_category_id_locale_key" ON "CategoryTranslation"("category_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "AttributeTemplateTranslation_template_id_locale_key" ON "AttributeTemplateTranslation"("template_id", "locale");

-- CreateIndex
CREATE INDEX "Product_provider_id_idx" ON "Product"("provider_id");

-- CreateIndex
CREATE INDEX "Product_creator_id_idx" ON "Product"("creator_id");

-- CreateIndex
CREATE INDEX "Product_category_id_idx" ON "Product"("category_id");

-- CreateIndex
CREATE INDEX "Product_status_idx" ON "Product"("status");

-- CreateIndex
CREATE INDEX "Product_product_type_idx" ON "Product"("product_type");

-- CreateIndex
CREATE INDEX "ProductTranslation_slug_idx" ON "ProductTranslation"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ProductTranslation_product_id_locale_key" ON "ProductTranslation"("product_id", "locale");

-- CreateIndex
CREATE UNIQUE INDEX "ProductAttribute_product_id_template_id_key" ON "ProductAttribute"("product_id", "template_id");

-- CreateIndex
CREATE INDEX "ProductTag_tag_idx" ON "ProductTag"("tag");

-- CreateIndex
CREATE UNIQUE INDEX "ProductVariant_sku_key" ON "ProductVariant"("sku");

-- CreateIndex
CREATE INDEX "ProductVariant_product_id_idx" ON "ProductVariant"("product_id");

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryTranslation" ADD CONSTRAINT "CategoryTranslation_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttributeTemplateTranslation" ADD CONSTRAINT "AttributeTemplateTranslation_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "AttributeTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryAttributeTemplate" ADD CONSTRAINT "CategoryAttributeTemplate_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "Category"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CategoryAttributeTemplate" ADD CONSTRAINT "CategoryAttributeTemplate_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "AttributeTemplate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_provider_id_fkey" FOREIGN KEY ("provider_id") REFERENCES "Provider"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "Creator"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductTranslation" ADD CONSTRAINT "ProductTranslation_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductImage" ADD CONSTRAINT "ProductImage_variant_id_fkey" FOREIGN KEY ("variant_id") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAttribute" ADD CONSTRAINT "ProductAttribute_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductAttribute" ADD CONSTRAINT "ProductAttribute_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "AttributeTemplate"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductTag" ADD CONSTRAINT "ProductTag_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductVariant" ADD CONSTRAINT "ProductVariant_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
