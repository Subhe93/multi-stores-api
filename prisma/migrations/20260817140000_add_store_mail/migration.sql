-- Per-store email sender and template overrides. Both are opt-in and only
-- consulted for INDEPENDENT stores; anything missing falls back to the
-- platform sender / platform template, so existing stores are unaffected.

CREATE TABLE "StoreMailSettings" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "smtp_host" TEXT,
    "smtp_port" INTEGER,
    "smtp_secure" BOOLEAN NOT NULL DEFAULT false,
    "smtp_user" TEXT,
    "smtp_pass" TEXT,
    "mail_from" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreMailSettings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreMailSettings_store_id_key" ON "StoreMailSettings"("store_id");

ALTER TABLE "StoreMailSettings" ADD CONSTRAINT "StoreMailSettings_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "StoreNotificationTemplate" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "subject" JSONB NOT NULL DEFAULT '{}',
    "body_html" JSONB NOT NULL DEFAULT '{}',
    "body_text" JSONB NOT NULL DEFAULT '{}',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreNotificationTemplate_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreNotificationTemplate_store_id_event_key" ON "StoreNotificationTemplate"("store_id", "event");
CREATE INDEX "StoreNotificationTemplate_store_id_idx" ON "StoreNotificationTemplate"("store_id");

ALTER TABLE "StoreNotificationTemplate" ADD CONSTRAINT "StoreNotificationTemplate_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
