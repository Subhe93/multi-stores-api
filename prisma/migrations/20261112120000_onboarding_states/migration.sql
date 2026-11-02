-- Platform onboarding, wave 1 (plans/platform-onboarding/SPEC.md §1).
-- Hand-written. Store lifecycle status, trader details, email verification,
-- creator onboarding profile and provider contact name.

-- Store lifecycle. `is_active` stays as a DERIVED column: the API writes
-- is_active = (status = 'LIVE') on every status change and nothing else
-- writes it.
CREATE TYPE "StoreStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'CHANGES_REQUESTED', 'LIVE', 'PAUSED', 'SUSPENDED');

ALTER TABLE "Store"
    ADD COLUMN "status" "StoreStatus" NOT NULL DEFAULT 'DRAFT',
    ADD COLUMN "status_reason" TEXT,
    ADD COLUMN "went_live_at" TIMESTAMP(3),
    ADD COLUMN "golive_requested_at" TIMESTAMP(3),
    ADD COLUMN "trader_details" JSONB;

-- D5: every existing store stays public (LIVE), an inactive one is PAUSED.
UPDATE "Store"
SET "status" = CASE WHEN "is_active" THEN 'LIVE'::"StoreStatus" ELSE 'PAUSED'::"StoreStatus" END,
    "went_live_at" = "created_at";

CREATE INDEX "Store_status_idx" ON "Store"("status");

-- Email verification reuses LoginToken rows with a new purpose.
ALTER TYPE "LoginTokenPurpose" ADD VALUE 'EMAIL_VERIFY';

ALTER TABLE "User" ADD COLUMN "email_verified_at" TIMESTAMP(3);

-- Existing staff accounts were ACTIVE without verification: treat them as
-- verified at creation so the new grace-period guard never locks them.
UPDATE "User" SET "email_verified_at" = "created_at" WHERE "role" <> 'CUSTOMER';

-- Creator: the sign-up profile (account kind, stage, country) and the last
-- name the register form used to discard.
ALTER TABLE "Creator"
    ADD COLUMN "onboarding_profile" JSONB,
    ADD COLUMN "last_name" TEXT;

-- Provider: a contact person, and the country comes from the sign-up form
-- (no more hard-coded 'US'); existing rows keep whatever they have.
ALTER TABLE "Provider"
    ADD COLUMN "contact_name" TEXT,
    ALTER COLUMN "country" DROP NOT NULL;
