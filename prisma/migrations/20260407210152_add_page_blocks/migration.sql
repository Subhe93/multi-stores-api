-- CreateEnum
CREATE TYPE "BlockType" AS ENUM ('HERO', 'TEXT', 'IMAGE', 'GALLERY', 'VIDEO', 'BEFORE_AFTER', 'FAQ', 'REVIEWS', 'CTA', 'CUSTOM_HTML', 'SPACER');

-- CreateTable
CREATE TABLE "PageBlock" (
    "id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "type" "BlockType" NOT NULL,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PageBlock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PageBlockTranslation" (
    "id" TEXT NOT NULL,
    "block_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "content" JSONB NOT NULL,

    CONSTRAINT "PageBlockTranslation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PageBlock_page_id_idx" ON "PageBlock"("page_id");

-- CreateIndex
CREATE UNIQUE INDEX "PageBlockTranslation_block_id_locale_key" ON "PageBlockTranslation"("block_id", "locale");

-- AddForeignKey
ALTER TABLE "PageBlock" ADD CONSTRAINT "PageBlock_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "StaticPage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PageBlockTranslation" ADD CONSTRAINT "PageBlockTranslation_block_id_fkey" FOREIGN KEY ("block_id") REFERENCES "PageBlock"("id") ON DELETE CASCADE ON UPDATE CASCADE;
