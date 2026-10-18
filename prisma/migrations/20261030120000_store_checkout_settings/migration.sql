-- M5 W2-A: per-store checkout behaviour (after-add-to-cart destination,
-- phone requirement, pay button label per locale, coupon URL params).
-- Additive and nullable: NULL keeps today's behaviour for every store.
ALTER TABLE "Store" ADD COLUMN "checkout_settings" JSONB;
