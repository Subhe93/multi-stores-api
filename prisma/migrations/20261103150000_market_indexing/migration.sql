-- M6.1: per-market search indexing mode replaces the boolean `noindex`.
-- AUTO   = indexable on a custom domain; the platform subdomain redirects to
--          the primary custom domain when one is ACTIVE, else robots noindex.
-- ALWAYS = indexable on any host.
-- NEVER  = robots noindex on any host (empty sitemap, out of hreflang).
-- The boolean was never deployed to production; markets flagged `noindex`
-- (if any) become NEVER before the column goes away.

CREATE TYPE "MarketIndexing" AS ENUM ('AUTO', 'ALWAYS', 'NEVER');

ALTER TABLE "Market"
  ADD COLUMN "indexing" "MarketIndexing" NOT NULL DEFAULT 'AUTO';

UPDATE "Market" SET "indexing" = 'NEVER' WHERE "noindex" = true;

ALTER TABLE "Market" DROP COLUMN "noindex";
