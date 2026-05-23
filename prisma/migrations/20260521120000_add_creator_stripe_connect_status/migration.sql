-- AlterTable: Stripe Connect onboarding state on Creator
ALTER TABLE "Creator" ADD COLUMN     "stripe_charges_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripe_payouts_enabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripe_onboarding_completed_at" TIMESTAMP(3);
