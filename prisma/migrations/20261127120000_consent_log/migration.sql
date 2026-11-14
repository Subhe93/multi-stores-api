-- Consent log (consent v2): proof of cookie consent per store decision.
-- Additive: one new table, no existing row changes. No raw IP / user agent
-- is stored (ip_prefix is /24 or /48, ua_hash is sha256). Rows older than
-- 24 months are purged by the `consent-log` retention task.
-- "vendors" has no NOT NULL on purpose: Prisma maps a `String[]` list to a
-- nullable column, so NOT NULL would show up as schema drift.
CREATE TABLE IF NOT EXISTS "ConsentLog" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "event_id" VARCHAR(36) NOT NULL,
    "consent_id" VARCHAR(36) NOT NULL,
    "action" VARCHAR(32) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "analytics" BOOLEAN,
    "marketing" BOOLEAN,
    "external_media" BOOLEAN,
    "consent_version" VARCHAR(8) NOT NULL,
    "vendors" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "text_hash" VARCHAR(64) NOT NULL,
    "locale" VARCHAR(10) NOT NULL,
    "ua_hash" VARCHAR(64),
    "ip_prefix" VARCHAR(45),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "ConsentLog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "ConsentLog_store_id_event_id_key" ON "ConsentLog"("store_id", "event_id");
CREATE INDEX IF NOT EXISTS "ConsentLog_store_id_created_at_idx" ON "ConsentLog"("store_id", "created_at");
CREATE INDEX IF NOT EXISTS "ConsentLog_store_id_consent_id_idx" ON "ConsentLog"("store_id", "consent_id");
CREATE INDEX IF NOT EXISTS "ConsentLog_created_at_idx" ON "ConsentLog"("created_at");

-- Guarded like the statements above, so a re-run after a partial apply does
-- not fail on "constraint already exists".
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'ConsentLog_store_id_fkey') THEN
        ALTER TABLE "ConsentLog" ADD CONSTRAINT "ConsentLog_store_id_fkey"
            FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
