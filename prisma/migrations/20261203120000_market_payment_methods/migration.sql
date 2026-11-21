-- M157: optional per-market payment methods (subset of card / kustom / cod).
-- Additive and nullable: every existing market reads NULL = the store's
-- methods, exactly as before. No default, no backfill, no table rewrite.
-- The CHECK keeps a set value a non-empty array of known methods; the API
-- validates the same rules with coded errors before it writes.
-- Rollback: ALTER TABLE "Market" DROP CONSTRAINT IF EXISTS "Market_payment_methods_check";
--           ALTER TABLE "Market" DROP COLUMN IF EXISTS "payment_methods";
ALTER TABLE "Market" ADD COLUMN IF NOT EXISTS "payment_methods" JSONB;

ALTER TABLE "Market" DROP CONSTRAINT IF EXISTS "Market_payment_methods_check";
-- CASE instead of AND: Postgres does not promise short-circuit evaluation,
-- and jsonb_array_length raises on a non-array instead of returning false.
ALTER TABLE "Market" ADD CONSTRAINT "Market_payment_methods_check" CHECK (
  "payment_methods" IS NULL OR (
    CASE
      WHEN jsonb_typeof("payment_methods") = 'array'
        THEN jsonb_array_length("payment_methods") BETWEEN 1 AND 3
          AND "payment_methods" <@ '["card","kustom","cod"]'::jsonb
      ELSE false
    END
  )
);
