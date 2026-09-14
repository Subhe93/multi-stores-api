-- Kustom Checkout (former Klarna Checkout) as a third payment method, offered
-- by INDEPENDENT stores only. Credentials live on the creator (secret is
-- encrypted at rest); the order keeps the Kustom order id, the secret token
-- embedded in the push/validation callback URLs and the capture bookkeeping.

-- AlterEnum
ALTER TYPE "PaymentMethod" ADD VALUE 'KUSTOM';

-- AlterTable
ALTER TABLE "Creator" ADD COLUMN     "kustom_merchant_id" TEXT,
ADD COLUMN     "kustom_shared_secret" TEXT,
ADD COLUMN     "kustom_environment" TEXT NOT NULL DEFAULT 'playground',
ADD COLUMN     "kustom_enabled" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "kustom_order_id" TEXT,
ADD COLUMN     "kustom_push_token" TEXT,
ADD COLUMN     "kustom_capture_id" TEXT,
ADD COLUMN     "kustom_captured_at" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "PlatformConfig" ADD COLUMN     "kustom_partner_id" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Order_kustom_order_id_key" ON "Order"("kustom_order_id");
