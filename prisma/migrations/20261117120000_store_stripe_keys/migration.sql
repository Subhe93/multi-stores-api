-- Own Stripe account (restricted key) for INDEPENDENT stores.
ALTER TABLE "Order" ADD COLUMN "payment_route" VARCHAR(16);
ALTER TABLE "Order" ADD COLUMN "stripe_key_fingerprint" VARCHAR(32);
ALTER TABLE "Order" ADD COLUMN "payment_processing_at" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "coupon_released_at" TIMESTAMP(3);
ALTER TABLE "Order" ADD COLUMN "stripe_intent_attempt" INTEGER NOT NULL DEFAULT 0;
-- Lease of the own-key save / verify / remove flow (see OwnKeyService.withLock).
ALTER TABLE "Store" ADD COLUMN "stripe_key_lock_until" TIMESTAMP(3);

CREATE TABLE "StoreStripeKeys" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "publishable_key" TEXT NOT NULL,
    "restricted_key_enc" TEXT NOT NULL,
    "key_last4" VARCHAR(4) NOT NULL,
    "livemode" BOOLEAN NOT NULL,
    "account_id" TEXT,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "permissions" JSONB NOT NULL DEFAULT '{}',
    "webhook_endpoint_id" TEXT,
    "webhook_secret_enc" TEXT,
    "payment_method_domains" JSONB NOT NULL DEFAULT '{}',
    "verified_at" TIMESTAMP(3),
    "last_check_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "key_fingerprint" VARCHAR(32),
    "previous_restricted_key_enc" TEXT,
    "previous_key_fingerprint" VARCHAR(32),
    "previous_webhook_endpoint_id" TEXT,
    "previous_webhook_secret_enc" TEXT,
    "previous_until" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreStripeKeys_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreStripeKeys_store_id_key" ON "StoreStripeKeys"("store_id");

ALTER TABLE "StoreStripeKeys" ADD CONSTRAINT "StoreStripeKeys_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
