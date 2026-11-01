-- AlterTable
ALTER TABLE "User" ADD COLUMN     "auth_failed_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "auth_locked_until" TIMESTAMP(3),
ADD COLUMN     "totp_enabled_at" TIMESTAMP(3),
ADD COLUMN     "totp_last_step" INTEGER,
ADD COLUMN     "totp_recovery_hashes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "totp_secret" TEXT;

-- CreateTable
CREATE TABLE "SecurityEvent" (
    "id" TEXT NOT NULL,
    "user_id" TEXT,
    "actor_email" TEXT NOT NULL,
    "actor_role" "UserRole",
    "action" TEXT NOT NULL,
    "target_type" TEXT,
    "target_id" TEXT,
    "target_label" TEXT,
    "fields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ip" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SecurityEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SecurityEvent_created_at_idx" ON "SecurityEvent"("created_at");

-- CreateIndex
CREATE INDEX "SecurityEvent_user_id_created_at_idx" ON "SecurityEvent"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "SecurityEvent_action_created_at_idx" ON "SecurityEvent"("action", "created_at");

-- AddForeignKey
ALTER TABLE "SecurityEvent" ADD CONSTRAINT "SecurityEvent_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

