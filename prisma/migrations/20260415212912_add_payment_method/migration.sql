-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('COD', 'STRIPE');

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "payment_method" "PaymentMethod" NOT NULL DEFAULT 'COD',
ADD COLUMN     "payment_status" TEXT;
