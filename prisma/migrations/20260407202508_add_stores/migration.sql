-- CreateEnum
CREATE TYPE "StaticPageType" AS ENUM ('ABOUT', 'CONTACT', 'PRIVACY_POLICY', 'TERMS', 'SHIPPING_POLICY', 'RETURN_POLICY', 'FAQ', 'CUSTOM');

-- CreateEnum
CREATE TYPE "PageStatus" AS ENUM ('DRAFT', 'PUBLISHED');

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "creator_id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "custom_domain" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "logo_url" TEXT,
    "favicon_url" TEXT,
    "theme_config" JSONB NOT NULL DEFAULT '{}',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreLanguageConfig" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "primary_locale" VARCHAR(5) NOT NULL DEFAULT 'en',
    "secondary_locales" TEXT[],
    "auto_translate" BOOLEAN NOT NULL DEFAULT false,
    "fallback_locale" VARCHAR(5) NOT NULL DEFAULT 'en',

    CONSTRAINT "StoreLanguageConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaticPage" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "type" "StaticPageType" NOT NULL,
    "slug" TEXT NOT NULL,
    "is_required" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "PageStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaticPage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StaticPageTranslation" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT,

    CONSTRAINT "StaticPageTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Store_creator_id_key" ON "Store"("creator_id");

-- CreateIndex
CREATE UNIQUE INDEX "Store_slug_key" ON "Store"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Store_custom_domain_key" ON "Store"("custom_domain");

-- CreateIndex
CREATE INDEX "Store_slug_idx" ON "Store"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "StoreLanguageConfig_store_id_key" ON "StoreLanguageConfig"("store_id");

-- CreateIndex
CREATE UNIQUE INDEX "StaticPage_store_id_slug_key" ON "StaticPage"("store_id", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "StaticPageTranslation_page_id_locale_key" ON "StaticPageTranslation"("page_id", "locale");

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_creator_id_fkey" FOREIGN KEY ("creator_id") REFERENCES "Creator"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreLanguageConfig" ADD CONSTRAINT "StoreLanguageConfig_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaticPage" ADD CONSTRAINT "StaticPage_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaticPageTranslation" ADD CONSTRAINT "StaticPageTranslation_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "StaticPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
