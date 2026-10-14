-- Per-store apps (feature add-ons). A row is the allowlist for one app of
-- one store: "available" is set by an admin, "enabled" by the creator, and
-- the app is in effect only when both are true. Stores with no rows have no
-- apps and behave exactly as before, so existing stores are unaffected.

CREATE TABLE "StoreApp" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "app_key" VARCHAR(32) NOT NULL,
    "available" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "enabled_at" TIMESTAMP(3),
    "enabled_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreApp_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreApp_store_id_app_key_key" ON "StoreApp"("store_id", "app_key");
CREATE INDEX "StoreApp_store_id_idx" ON "StoreApp"("store_id");

ALTER TABLE "StoreApp" ADD CONSTRAINT "StoreApp_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
