-- Store type: MARKETPLACE (provider + creator products, platform commission +
-- transfers) or INDEPENDENT (creator-only products, direct charges, no commission).
CREATE TYPE "StoreType" AS ENUM ('MARKETPLACE', 'INDEPENDENT');

ALTER TABLE "Store" ADD COLUMN     "store_type" "StoreType" NOT NULL DEFAULT 'MARKETPLACE';

-- Connected account type: 'express' (transfers model) or 'standard' (direct charges).
ALTER TABLE "Creator" ADD COLUMN     "stripe_account_type" TEXT;

-- Snapshot of the connected account a direct-charge PaymentIntent was created on.
ALTER TABLE "Order" ADD COLUMN     "stripe_account_id" TEXT;

-- Signing secret of the Connect (connected accounts) webhook endpoint.
ALTER TABLE "PlatformConfig" ADD COLUMN     "stripe_connect_webhook_secret" TEXT;
