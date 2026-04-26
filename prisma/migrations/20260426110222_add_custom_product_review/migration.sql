-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ProductStatus" ADD VALUE 'PENDING_REVIEW';
ALTER TYPE "ProductStatus" ADD VALUE 'REJECTED';

-- AlterTable
ALTER TABLE "CustomProduct" ADD COLUMN     "rejection_reason" TEXT,
ADD COLUMN     "reviewed_at" TIMESTAMP(3),
ADD COLUMN     "reviewed_by" TEXT,
ADD COLUMN     "submitted_at" TIMESTAMP(3);
