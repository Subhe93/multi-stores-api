-- Markets app follow-up.
--
-- 1. The default-market backfill stored 'EUR' for stores without their own
--    currency, while the runtime resolves such stores to the platform
--    default. Align the stored column (the runtime keeps reading the store
--    currency live; this only keeps the row honest). Idempotent.
UPDATE "Market" m
SET "currency" = COALESCE(
      s."currency",
      (SELECT "default_currency" FROM "PlatformConfig" LIMIT 1),
      'EUR'
    ),
    "updated_at" = now()
FROM "Store" s
WHERE m."store_id" = s."id"
  AND m."is_default"
  AND m."currency" IS DISTINCT FROM COALESCE(
      s."currency",
      (SELECT "default_currency" FROM "PlatformConfig" LIMIT 1),
      'EUR'
    );

-- 2. The DNS records seen by the last "Verify" of a hostname, so the
--    dashboard can show them after a failed check.
ALTER TABLE "StoreDomain" ADD COLUMN "last_observed" JSONB;
