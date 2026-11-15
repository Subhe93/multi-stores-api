-- Per-product confirmation email note (headless booking E2.1). Additive: one
-- nullable column, no default, no backfill; null = no note, so every existing
-- product and every order email stays as it is. Plain text, max 500
-- characters (enforced by the API DTO, no CHECK constraint). The column is
-- omitted globally by the API (PRISMA_GLOBAL_OMIT), so no public payload
-- carries it. Rollback: drop the column.
ALTER TABLE "ProductTranslation" ADD COLUMN IF NOT EXISTS "email_note" TEXT;
