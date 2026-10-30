-- Zoho Mail app: per-store Zoho OAuth client (client secret encrypted) and
-- the mailbox connected with it. Opt-in; a store without a row keeps sending
-- through its SMTP sender or the platform sender.

CREATE TABLE "StoreZohoMail" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "client_id" TEXT,
    "client_secret" TEXT,
    "connected_email" TEXT,
    "account_id" TEXT,
    "from_address" TEXT,
    "from_name" TEXT,
    "available_from" JSONB NOT NULL DEFAULT '[]',
    "refresh_token" TEXT,
    "access_token" TEXT,
    "access_expires_at" TIMESTAMP(3),
    "connected_at" TIMESTAMP(3),
    "verified_at" TIMESTAMP(3),
    "last_error" TEXT,
    "last_error_detail" TEXT,
    "last_error_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreZohoMail_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreZohoMail_store_id_key" ON "StoreZohoMail"("store_id");

ALTER TABLE "StoreZohoMail" ADD CONSTRAINT "StoreZohoMail_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
