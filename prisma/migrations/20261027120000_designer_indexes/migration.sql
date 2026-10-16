-- M4.2 designer fixes: indexes for the retention / queue paths and store
-- deletion. Additive: indexes, two new store FKs (cascade) and two existing
-- RESTRICT FKs relaxed to NO ACTION (same protection, checked at the end of
-- the statement so a store / creator deletion that cascades to both sides
-- succeeds).

-- Order designs of a design (R1 draft check, R3 shared-photo / strip
-- checks, payment-failure release).
CREATE INDEX IF NOT EXISTS "OrderItemDesign_design_id_idx" ON "OrderItemDesign"("design_id");

-- Print queue claim: only requested, unpurged, non-terminal rows (partial;
-- not expressible in schema.prisma, like the other partial indexes).
CREATE INDEX IF NOT EXISTS "OrderItemDesign_queue_claim_idx"
    ON "OrderItemDesign"("print_requested_at")
    WHERE "print_requested_at" IS NOT NULL
      AND "files_purged_at" IS NULL
      AND "terminal_at" IS NULL;

-- R2 orphans: `assets @> [{"asset_id": …}]` uses this GIN index (jsonb_path_ops
-- supports @>) instead of scanning every snapshot of the store.
CREATE INDEX IF NOT EXISTS "OrderItemDesign_assets_gin_idx"
    ON "OrderItemDesign" USING GIN ("assets" jsonb_path_ops);

-- Store deletion: designs and product links go with their store.
ALTER TABLE "Design" ADD CONSTRAINT "Design_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductDesigner" ADD CONSTRAINT "ProductDesigner_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RESTRICT → NO ACTION (versions / templates in use still cannot be deleted).
ALTER TABLE "Design" DROP CONSTRAINT "Design_template_version_id_fkey";
ALTER TABLE "Design" ADD CONSTRAINT "Design_template_version_id_fkey"
    FOREIGN KEY ("template_version_id") REFERENCES "DesignTemplateVersion"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
ALTER TABLE "ProductDesigner" DROP CONSTRAINT "ProductDesigner_template_id_fkey";
ALTER TABLE "ProductDesigner" ADD CONSTRAINT "ProductDesigner_template_id_fkey"
    FOREIGN KEY ("template_id") REFERENCES "DesignTemplate"("id") ON DELETE NO ACTION ON UPDATE CASCADE;
