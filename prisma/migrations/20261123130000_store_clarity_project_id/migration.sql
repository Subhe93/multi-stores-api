-- Microsoft Clarity (heatmaps + session recordings) per store. Public project
-- id only (no secret); NULL = Clarity off. The storefront loads Clarity only
-- after the visitor accepts cookies, regardless of consent_required.
ALTER TABLE "Store" ADD COLUMN "clarity_project_id" VARCHAR(32);
