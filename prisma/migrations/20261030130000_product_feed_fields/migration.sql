-- M5 W2-D feeds app: product feed identifiers (Google Merchant / Meta catalog).
-- Additive: six nullable/defaulted columns on "Product", no changes to
-- existing rows (every product keeps serving exactly as before; feeds skip
-- rows with feed_excluded = true).
ALTER TABLE "Product"
    ADD COLUMN "gtin" VARCHAR(14),
    ADD COLUMN "mpn" VARCHAR(70),
    ADD COLUMN "brand" VARCHAR(70),
    ADD COLUMN "google_product_category" VARCHAR(191),
    ADD COLUMN "condition" VARCHAR(16),
    ADD COLUMN "feed_excluded" BOOLEAN NOT NULL DEFAULT false;
