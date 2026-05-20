-- WordPress-style navigation menus. A store owns multiple named menus
-- (e.g. "main-nav", "footer-shop"), each a list of links the creator
-- builds once and references from any chrome section. Items can nest
-- via parent_id for dropdowns / mega-menu groups (editor support in v2).

CREATE TABLE "Menu" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Menu_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "MenuItem" (
    "id" TEXT NOT NULL,
    "menu_id" TEXT NOT NULL,
    "parent_id" TEXT,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "open_in_new_tab" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Menu_store_id_key_key" ON "Menu"("store_id", "key");
CREATE INDEX "Menu_store_id_idx" ON "Menu"("store_id");
CREATE INDEX "MenuItem_menu_id_parent_id_sort_order_idx" ON "MenuItem"("menu_id", "parent_id", "sort_order");

ALTER TABLE "Menu" ADD CONSTRAINT "Menu_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "Store"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_menu_id_fkey"
    FOREIGN KEY ("menu_id") REFERENCES "Menu"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_parent_id_fkey"
    FOREIGN KEY ("parent_id") REFERENCES "MenuItem"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
