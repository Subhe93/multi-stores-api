-- Featured product video (position 0) and muted autoplay options for product
-- videos and customer-story videos. Additive: new columns with defaults; the
-- position CHECK is relaxed from >= 1 to >= 0 (no existing row changes).
ALTER TABLE "ProductVideo" ADD COLUMN "autoplay" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProductVideo" ADD COLUMN "loop" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "ProductVideo" DROP CONSTRAINT "ProductVideo_position_check";
ALTER TABLE "ProductVideo" ADD CONSTRAINT "ProductVideo_position_check" CHECK ("position" >= 0);

-- At most one featured video per product. Partial index: Prisma cannot model
-- it (listed in prisma/RAW-SQL.md + the raw-sql.spec.ts allowlist), so a
-- generated diff shows a DROP INDEX for it; never copy that into a migration.
CREATE UNIQUE INDEX IF NOT EXISTS "ProductVideo_product_id_featured_key"
    ON "ProductVideo"("product_id") WHERE "position" = 0;

ALTER TABLE "ProductStory" ADD COLUMN "autoplay" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ProductStory" ADD COLUMN "loop" BOOLEAN NOT NULL DEFAULT false;
