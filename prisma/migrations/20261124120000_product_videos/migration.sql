-- Product videos shown in the product gallery next to ProductImage (additive only).
CREATE TYPE "ProductVideoKind" AS ENUM ('FILE', 'YOUTUBE', 'VIMEO');

CREATE TABLE "ProductVideo" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "kind" "ProductVideoKind" NOT NULL,
    "url" TEXT NOT NULL,
    "poster_url" TEXT,
    "alt_text" TEXT,
    "duration_s" INTEGER,
    "width" INTEGER,
    "height" INTEGER,
    "position" INTEGER NOT NULL DEFAULT 1,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductVideo_pkey" PRIMARY KEY ("id"),
    -- Decision D6: the first gallery slot is always an image.
    CONSTRAINT "ProductVideo_position_check" CHECK ("position" >= 1)
);

CREATE INDEX "ProductVideo_product_id_position_idx" ON "ProductVideo"("product_id", "position");
CREATE INDEX "ProductVideo_url_idx" ON "ProductVideo"("url");

ALTER TABLE "ProductVideo" ADD CONSTRAINT "ProductVideo_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;
