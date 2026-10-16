-- M4.0 backfill of the OrderCustomFieldValue snapshot columns. Kept as a
-- standalone file so the e2e suite can replay it after `prisma db push`;
-- pasted verbatim into the 20261019120000_m4_0_order_field_snapshot
-- migration. Idempotent: every statement only touches rows it has not filled
-- yet, so running it twice changes nothing.

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
