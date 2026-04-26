/*
  Warnings:

  - You are about to drop the column `design_id` on the `CustomProduct` table. All the data in the column will be lost.
  - You are about to drop the `Design` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DesignFile` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `DesignTranslation` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "CustomProduct" DROP CONSTRAINT "CustomProduct_design_id_fkey";

-- DropForeignKey
ALTER TABLE "Design" DROP CONSTRAINT "Design_creator_id_fkey";

-- DropForeignKey
ALTER TABLE "DesignFile" DROP CONSTRAINT "DesignFile_design_id_fkey";

-- DropForeignKey
ALTER TABLE "DesignTranslation" DROP CONSTRAINT "DesignTranslation_design_id_fkey";

-- AlterTable
ALTER TABLE "CustomProduct" DROP COLUMN "design_id";

-- DropTable
DROP TABLE "Design";

-- DropTable
DROP TABLE "DesignFile";

-- DropTable
DROP TABLE "DesignTranslation";

-- DropEnum
DROP TYPE "DesignStatus";
