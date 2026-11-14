-- Customer stories per product, shown by the product-stories block (additive only).
CREATE TYPE "ProductStoryKind" AS ENUM ('IMAGE', 'FILE', 'YOUTUBE', 'VIMEO');

CREATE TABLE "ProductStory" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "kind" "ProductStoryKind" NOT NULL,
    "url" TEXT NOT NULL,
    "poster_url" TEXT,
    "duration_s" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "name" TEXT NOT NULL,
    "rating" INTEGER,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductStory_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ProductStory_rating_check" CHECK ("rating" IS NULL OR ("rating" >= 1 AND "rating" <= 5))
);

CREATE TABLE "ProductStoryTranslation" (
    "id" TEXT NOT NULL,
    "story_id" TEXT NOT NULL,
    "locale" VARCHAR(5) NOT NULL,
    "quote" TEXT NOT NULL,
    "subtitle" TEXT,
    CONSTRAINT "ProductStoryTranslation_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ProductStory_product_id_sort_order_idx" ON "ProductStory"("product_id", "sort_order");
CREATE INDEX "ProductStory_url_idx" ON "ProductStory"("url");
CREATE INDEX "ProductStory_poster_url_idx" ON "ProductStory"("poster_url");
CREATE UNIQUE INDEX "ProductStoryTranslation_story_id_locale_key" ON "ProductStoryTranslation"("story_id", "locale");

ALTER TABLE "ProductStory" ADD CONSTRAINT "ProductStory_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductStoryTranslation" ADD CONSTRAINT "ProductStoryTranslation_story_id_fkey"
    FOREIGN KEY ("story_id") REFERENCES "ProductStory"("id") ON DELETE CASCADE ON UPDATE CASCADE;
