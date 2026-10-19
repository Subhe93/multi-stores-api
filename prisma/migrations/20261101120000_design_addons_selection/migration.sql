-- Designer add-ons (M5.5): the customer's add-on selection of a design
-- ({key: qty}). Nullable without a default: existing rows and designs of
-- products without add-ons stay unchanged.
ALTER TABLE "Design" ADD COLUMN "addons" JSONB;
