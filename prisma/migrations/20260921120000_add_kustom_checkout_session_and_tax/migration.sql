-- Kustom-first checkout: a checkout session that exists before the order does
-- (the order is created inside Kustom's validation callback), plus
-- platform-wide VAT: a platform default rate, an optional per-store override
-- (basis points, prices are tax inclusive) and the rate/amount snapshotted on
-- every order. Orders also snapshot the chosen shipping method's name.

-- AlterTable
ALTER TABLE "PlatformConfig" ADD COLUMN     "default_tax_rate_bp" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Store" ADD COLUMN     "tax_rate_bp" INTEGER;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "tax_rate_bp" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "tax_amount" DECIMAL(10,2) NOT NULL DEFAULT 0,
ADD COLUMN     "shipping_method_name" TEXT;

-- CreateTable
CREATE TABLE "KustomCheckoutSession" (
    "id" TEXT NOT NULL,
    "store_id" TEXT NOT NULL,
    "customer_id" TEXT,
    "kustom_order_id" TEXT,
    "token" TEXT NOT NULL,
    "callback_token" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "locale" VARCHAR(10),
    "currency" VARCHAR(3) NOT NULL,
    "items" JSONB NOT NULL,
    "coupon_code" TEXT,
    "notes" TEXT,
    "country_code" VARCHAR(2),
    "purchase_country" VARCHAR(2),
    "shipping_method_id" TEXT,
    "shipping_cost" DECIMAL(10,2) NOT NULL DEFAULT 0,
    "order_id" TEXT,
    "account_created" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KustomCheckoutSession_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KustomCheckoutSession_kustom_order_id_key" ON "KustomCheckoutSession"("kustom_order_id");

-- CreateIndex
CREATE UNIQUE INDEX "KustomCheckoutSession_order_id_key" ON "KustomCheckoutSession"("order_id");

-- CreateIndex
CREATE INDEX "KustomCheckoutSession_store_id_idx" ON "KustomCheckoutSession"("store_id");

-- AddForeignKey
ALTER TABLE "KustomCheckoutSession" ADD CONSTRAINT "KustomCheckoutSession_store_id_fkey" FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
