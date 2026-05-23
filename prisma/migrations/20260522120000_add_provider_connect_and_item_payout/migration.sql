-- Provider Stripe Connect onboarding state.
ALTER TABLE "Provider" ADD COLUMN     "stripe_charges_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripe_payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripe_onboarding_completed_at" TIMESTAMP(3);

-- Per-item provider base, used to split payout transfers per provider.
ALTER TABLE "OrderItem" ADD COLUMN     "provider_base_amount" DECIMAL(10,2) NOT NULL DEFAULT 0;
