-- One-click login links (plans/account-credentials): auto-created accounts
-- get an email with their password and a single-use magic link. Only the
-- sha256 hex of the raw token is stored. Hand-written: new table only.

CREATE TYPE "LoginTokenPurpose" AS ENUM ('MAGIC_LOGIN');

CREATE TABLE "LoginToken" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "purpose" "LoginTokenPurpose" NOT NULL DEFAULT 'MAGIC_LOGIN',
    "store_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "used_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LoginToken_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "LoginToken_token_hash_key" ON "LoginToken"("token_hash");

CREATE INDEX "LoginToken_user_id_idx" ON "LoginToken"("user_id");

ALTER TABLE "LoginToken" ADD CONSTRAINT "LoginToken_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "LoginToken" ADD CONSTRAINT "LoginToken_store_id_fkey"
    FOREIGN KEY ("store_id") REFERENCES "Store"("id") ON DELETE SET NULL ON UPDATE CASCADE;
