-- Test orders (own Stripe key in TEST mode, or the owner's pre-live checkout).
-- Existing orders are real orders: the default false keeps them counted.
ALTER TABLE "Order" ADD COLUMN "is_test" BOOLEAN NOT NULL DEFAULT false;
