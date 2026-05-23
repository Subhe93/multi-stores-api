-- Order payment details captured from Stripe.
ALTER TABLE "Order" ADD COLUMN     "stripe_charge_id" TEXT,
ADD COLUMN     "card_brand" TEXT,
ADD COLUMN     "card_last4" VARCHAR(4),
ADD COLUMN     "receipt_url" TEXT,
ADD COLUMN     "paid_at" TIMESTAMP(3),
ADD COLUMN     "payment_failure_code" TEXT,
ADD COLUMN     "payment_failure_message" TEXT;

-- Per-recipient payout ledger (Stripe transfers).
CREATE TABLE "OrderPayout" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "recipient_type" "FulfillerType" NOT NULL,
    "recipient_id" TEXT NOT NULL,
    "stripe_account_id" TEXT,
    "stripe_transfer_id" TEXT,
    "amount" DECIMAL(10,2) NOT NULL,
    "currency" VARCHAR(3) NOT NULL DEFAULT 'EUR',
    "status" TEXT NOT NULL DEFAULT 'paid',
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OrderPayout_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OrderPayout_order_id_recipient_type_recipient_id_key" ON "OrderPayout"("order_id", "recipient_type", "recipient_id");
CREATE INDEX "OrderPayout_recipient_id_idx" ON "OrderPayout"("recipient_id");
CREATE INDEX "OrderPayout_order_id_idx" ON "OrderPayout"("order_id");

ALTER TABLE "OrderPayout" ADD CONSTRAINT "OrderPayout_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
