-- M6: typed menu items (WordPress-style editor). `kind` says what the item
-- points at and `resource_id` keeps the picked page / collection / product
-- id; `url` stays the rendered link. Existing rows become CUSTOM.

CREATE TYPE "MenuItemKind" AS ENUM ('CUSTOM', 'PAGE', 'COLLECTION', 'PRODUCT');

ALTER TABLE "MenuItem"
  ADD COLUMN "kind" "MenuItemKind" NOT NULL DEFAULT 'CUSTOM',
  ADD COLUMN "resource_id" TEXT;
