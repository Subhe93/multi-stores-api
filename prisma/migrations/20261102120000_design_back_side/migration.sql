-- Designer double-sided (M5.6): an optional back side per design.
-- Every column is nullable (or defaults to empty), so existing rows and
-- single-sided designs are unchanged (G0).

-- Design: the back side ({mode:'same'} | {mode:'other', template_id,
-- template_version_id, state}) and its proof bookkeeping.
ALTER TABLE "Design"
  ADD COLUMN "back" JSONB,
  ADD COLUMN "proof_back_key" TEXT,
  ADD COLUMN "proof_back_sha" VARCHAR(64);

-- ProductDesigner: templates the merchant offers for the back besides the
-- product's own template (empty = only the same template).
ALTER TABLE "ProductDesigner"
  ADD COLUMN "back_template_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- OrderItemDesign: the frozen back (template spec + state) so later template
-- edits never change the print output, plus the back proof.
ALTER TABLE "OrderItemDesign"
  ADD COLUMN "back_mode" VARCHAR(8),
  ADD COLUMN "back_template_id" TEXT,
  ADD COLUMN "back_template_version_id" TEXT,
  ADD COLUMN "back_template_spec" JSONB,
  ADD COLUMN "back_state" JSONB,
  ADD COLUMN "proof_back_key" TEXT;
