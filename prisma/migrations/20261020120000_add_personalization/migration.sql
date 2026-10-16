-- Personalization app (M4.1). Three app-only field types, the advanced field
-- config (repeater parent, conditions, pricing, repeat, ui, preset audit),
-- per-locale help/messages on translations, the grouping/pricing snapshot on
-- order field values (M4.0's sort_order is reused, no own column), the
-- per-unit personalization amount on order items and the store-scoped field
-- library. Every new column is nullable or defaulted, so existing rows and
-- stores without the app are unchanged. Nothing is backfilled.
-- The new enum values are not used in this migration (PG >= 12 allows
-- ADD VALUE inside the migration transaction under that condition).

-- AlterEnum
ALTER TYPE "CustomFieldType" ADD VALUE IF NOT EXISTS 'CHECKBOX_GROUP';
ALTER TYPE "CustomFieldType" ADD VALUE IF NOT EXISTS 'COLOR_PALETTE';
ALTER TYPE "CustomFieldType" ADD VALUE IF NOT EXISTS 'REPEATER';

-- AlterTable
ALTER TABLE "ProductCustomField" ADD COLUMN     "parent_id" TEXT,
ADD COLUMN     "conditions" JSONB,
ADD COLUMN     "pricing" JSONB,
ADD COLUMN     "repeat" JSONB,
ADD COLUMN     "ui" JSONB,
ADD COLUMN     "preset_key" VARCHAR(48),
ADD COLUMN     "preset_ref" VARCHAR(191);

-- CreateIndex
CREATE INDEX "ProductCustomField_parent_id_idx" ON "ProductCustomField"("parent_id");

-- AddForeignKey
ALTER TABLE "ProductCustomField" ADD CONSTRAINT "ProductCustomField_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "ProductCustomField"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "CustomFieldTranslation" ADD COLUMN     "display_label" TEXT,
ADD COLUMN     "sublabel" TEXT,
ADD COLUMN     "note" TEXT,
ADD COLUMN     "help_text" TEXT,
ADD COLUMN     "help_image_url" TEXT,
ADD COLUMN     "messages" JSONB;

-- AlterTable
ALTER TABLE "OrderCustomFieldValue" ADD COLUMN     "group_key" VARCHAR(64),
ADD COLUMN     "group_index" INTEGER,
ADD COLUMN     "group_label" JSONB,
ADD COLUMN     "source" VARCHAR(8) NOT NULL DEFAULT 'FIELD',
ADD COLUMN     "price_delta" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "meta" JSONB;

-- AlterTable
ALTER TABLE "OrderItem" ADD COLUMN     "personalization_amount" DECIMAL(10,2);

-- CreateTable
CREATE TABLE "PersonalizationFieldTemplate" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "definition" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PersonalizationFieldTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PersonalizationFieldTemplate_store_id_idx" ON "PersonalizationFieldTemplate"("store_id");

-- AddForeignKey
ALTER TABLE "PersonalizationFieldTemplate" ADD CONSTRAINT "PersonalizationFieldTemplate_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
