-- AlterTable: platform-level Stripe credentials, managed from the admin dashboard.
ALTER TABLE "PlatformConfig" ADD COLUMN     "stripe_secret_key" TEXT,
ADD COLUMN     "stripe_publishable_key" TEXT,
ADD COLUMN     "stripe_webhook_secret" TEXT;
