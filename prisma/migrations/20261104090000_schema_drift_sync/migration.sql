-- Schema/migration drift sync (found by prisma/raw-sql.spec.ts, 2026-10-28).
-- Hand-written and idempotent: production already carries both states.
--
-- 1. Store.cache_enabled was added to schema.prisma (commit bea87cf) without
--    a migration; the column exists on production (storefront reads it).
ALTER TABLE "Store" ADD COLUMN IF NOT EXISTS "cache_enabled" BOOLEAN NOT NULL DEFAULT true;

-- 2. The pages-v2 migration gave the Page tables a DB default for "id"
--    (gen_random_uuid()::text) while schema.prisma uses @default(uuid()),
--    which the Prisma client supplies on every insert. No raw INSERT relies
--    on the DB default, so dropping it only aligns the two.
ALTER TABLE "Page" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "PageSection" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "PageSectionTranslation" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "PageTranslation" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "PageVersion" ALTER COLUMN "id" DROP DEFAULT;
