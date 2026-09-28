-- Email delivery log (one row per SMTP attempt, no bodies) and a per-store
-- address for "new order" notifications (null = the creator's login email).
CREATE TYPE "EmailLogStatus" AS ENUM ('SENT', 'FAILED', 'SKIPPED');

ALTER TABLE "Store" ADD COLUMN     "notification_email" TEXT;

CREATE TABLE "EmailLog" (
    "id" TEXT NOT NULL,
    "store_id" TEXT,
    "order_id" TEXT,
    "event" TEXT,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "EmailLogStatus" NOT NULL,
    "via" TEXT,
    "smtp_host" TEXT,
    "error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailLog_created_at_idx" ON "EmailLog"("created_at");

CREATE INDEX "EmailLog_store_id_created_at_idx" ON "EmailLog"("store_id", "created_at");
