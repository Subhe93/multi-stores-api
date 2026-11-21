-- M156: optional language-country URL paths per market (/de-de/, /de-at/).
-- Additive and nullable: every existing market reads NULL = today's bare
-- /<locale>/ folders. No default, no backfill, no table rewrite.
-- Rollback: drop the column.
ALTER TABLE "Market" ADD COLUMN IF NOT EXISTS "locale_paths" JSONB;
