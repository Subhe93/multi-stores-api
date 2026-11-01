-- Separate failure counter for re-auth inside a session (audit M3): a stolen
-- token guessing passwords must not lock the owner out of signing in.
ALTER TABLE "User" ADD COLUMN "reauth_failed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "reauth_locked_until" TIMESTAMP(3);
