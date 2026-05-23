-- AlterTable: platform SMTP email settings, managed from the admin dashboard.
ALTER TABLE "PlatformConfig" ADD COLUMN     "smtp_host" TEXT,
ADD COLUMN     "smtp_port" INTEGER,
ADD COLUMN     "smtp_secure" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "smtp_user" TEXT,
ADD COLUMN     "smtp_pass" TEXT,
ADD COLUMN     "mail_from" TEXT;
