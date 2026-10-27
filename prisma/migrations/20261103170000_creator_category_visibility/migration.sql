-- M6.3: collection visibility. PUBLIC = storefront collection (page, menus,
-- breadcrumbs, sitemap); INTERNAL = flat label used to group products for
-- builder pages only, never served as a collection. No backfill: every
-- existing row stays PUBLIC.
CREATE TYPE "CreatorCategoryVisibility" AS ENUM ('PUBLIC', 'INTERNAL');

ALTER TABLE "CreatorCategory" ADD COLUMN "visibility" "CreatorCategoryVisibility" NOT NULL DEFAULT 'PUBLIC';
