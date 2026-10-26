-- M6: primary collection of a product / custom product (breadcrumb and feed
-- category path). Nullable; the service keeps it equal to one of the linked
-- collections. Deleting the collection clears it (SET NULL) while the link
-- row itself cascades away.

ALTER TABLE "Product"
  ADD COLUMN "primary_creator_category_id" TEXT;

ALTER TABLE "CustomProduct"
  ADD COLUMN "primary_creator_category_id" TEXT;

CREATE INDEX "Product_primary_creator_category_id_idx"
  ON "Product"("primary_creator_category_id");

CREATE INDEX "CustomProduct_primary_creator_category_id_idx"
  ON "CustomProduct"("primary_creator_category_id");

ALTER TABLE "Product"
  ADD CONSTRAINT "Product_primary_creator_category_id_fkey"
  FOREIGN KEY ("primary_creator_category_id") REFERENCES "CreatorCategory"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "CustomProduct"
  ADD CONSTRAINT "CustomProduct_primary_creator_category_id_fkey"
  FOREIGN KEY ("primary_creator_category_id") REFERENCES "CreatorCategory"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: the existing first link (lowest sort_order, then id) becomes the
-- primary so every linked product has one from day one.
UPDATE "Product" p
SET "primary_creator_category_id" = l."creator_category_id"
FROM (
  SELECT DISTINCT ON ("product_id") "product_id", "creator_category_id"
  FROM "ProductCreatorCategory"
  ORDER BY "product_id", "sort_order" ASC, "creator_category_id" ASC
) l
WHERE l."product_id" = p."id" AND p."primary_creator_category_id" IS NULL;

UPDATE "CustomProduct" cp
SET "primary_creator_category_id" = l."creator_category_id"
FROM (
  SELECT DISTINCT ON ("custom_product_id") "custom_product_id", "creator_category_id"
  FROM "CustomProductCreatorCategory"
  ORDER BY "custom_product_id", "sort_order" ASC, "creator_category_id" ASC
) l
WHERE l."custom_product_id" = cp."id" AND cp."primary_creator_category_id" IS NULL;
