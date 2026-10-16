-- M4.0 (platform-wide fix, bug 6): OrderCustomFieldValue keeps a frozen copy
-- of the field it was ordered with, and deleting a field no longer fails once
-- an order references it (SET NULL; the snapshot keeps the history readable).
-- A creator's prefilled value for a deleted field is meaningless, so
-- CustomProductFieldValue now cascades. All new columns are nullable; orders
-- without custom field values are untouched.

-- AlterTable
ALTER TABLE "OrderCustomFieldValue"
    ADD COLUMN "field_name" TEXT,
    ADD COLUMN "field_type" "CustomFieldType",
    ADD COLUMN "field_label" JSONB,
    ADD COLUMN "display_value" JSONB,
    ADD COLUMN "sort_order" INTEGER;

-- AlterTable
ALTER TABLE "OrderCustomFieldValue" ALTER COLUMN "custom_field_id" DROP NOT NULL;

-- DropForeignKey
ALTER TABLE "OrderCustomFieldValue" DROP CONSTRAINT "OrderCustomFieldValue_custom_field_id_fkey";

-- AddForeignKey
ALTER TABLE "OrderCustomFieldValue" ADD CONSTRAINT "OrderCustomFieldValue_custom_field_id_fkey" FOREIGN KEY ("custom_field_id") REFERENCES "ProductCustomField"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- DropForeignKey
ALTER TABLE "CustomProductFieldValue" DROP CONSTRAINT "CustomProductFieldValue_custom_field_id_fkey";

-- AddForeignKey
ALTER TABLE "CustomProductFieldValue" ADD CONSTRAINT "CustomProductFieldValue_custom_field_id_fkey" FOREIGN KEY ("custom_field_id") REFERENCES "ProductCustomField"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
CREATE INDEX "OrderCustomFieldValue_custom_field_id_idx" ON "OrderCustomFieldValue"("custom_field_id");

-- Backfill (verbatim copy of prisma/sql/m4-0-backfill-order-field-snapshot.sql;
-- idempotent).

-- 1. Field name, type, sort order and every translated label, read from the
--    live field. Before M4.0 the foreign key was RESTRICT, so every existing
--    row still has its field.
UPDATE "OrderCustomFieldValue" v
SET "field_name" = f."name",
    "field_type" = f."type",
    "sort_order" = f."sort_order",
    "field_label" = (
        SELECT jsonb_object_agg(t."locale", t."label")
        FROM "CustomFieldTranslation" t
        WHERE t."field_id" = f."id"
    )
FROM "ProductCustomField" f
WHERE f."id" = v."custom_field_id"
  AND v."field_name" IS NULL;

-- 2. Option labels per locale for SELECT/FONT values (only locales that
--    translate the chosen option).
UPDATE "OrderCustomFieldValue" v
SET "display_value" = (
        SELECT jsonb_object_agg(t."locale", t."option_labels" ->> v."value")
        FROM "CustomFieldTranslation" t
        WHERE t."field_id" = f."id"
          AND jsonb_typeof(t."option_labels") = 'object'
          AND t."option_labels" ? v."value"
    )
FROM "ProductCustomField" f
WHERE f."id" = v."custom_field_id"
  AND f."type" IN ('SELECT', 'FONT')
  AND v."value" IS NOT NULL
  AND v."display_value" IS NULL
  AND EXISTS (
        SELECT 1
        FROM "CustomFieldTranslation" t
        WHERE t."field_id" = f."id"
          AND jsonb_typeof(t."option_labels") = 'object'
          AND t."option_labels" ? v."value"
    );

-- 3. Bug 5 repair: before M4.0 any value starting with "http" or "/uploads"
--    was stored as file_url whatever the field type. Text-like fields get it
--    back as value. Uses the snapshot type, so it also works after the field
--    has been deleted.
UPDATE "OrderCustomFieldValue" v
SET "value" = v."file_url",
    "file_url" = NULL
WHERE v."field_type" IS NOT NULL
  AND v."field_type" NOT IN ('IMAGE', 'FILE', 'MULTI_IMAGE')
  AND v."value" IS NULL
  AND v."file_url" IS NOT NULL;
