-- Page section tree (product template layout containers). Additive and
-- nullable: every existing section stays at the root (parent_id NULL), so
-- existing pages render exactly as before. Only layout-row / layout-column /
-- layout-grid sections may be parents (enforced by the API); sort_order is
-- scoped to siblings. Deleting a container deletes its descendants.
ALTER TABLE "PageSection" ADD COLUMN "parent_id" TEXT;

CREATE INDEX "PageSection_page_id_parent_id_sort_order_idx" ON "PageSection"("page_id", "parent_id", "sort_order");

ALTER TABLE "PageSection" ADD CONSTRAINT "PageSection_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "PageSection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
