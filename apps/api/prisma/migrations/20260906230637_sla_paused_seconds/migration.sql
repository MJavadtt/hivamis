/*
  Warnings:

  - You are about to drop the column `pausedMs` on the `sla_clocks` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "sla_clocks" DROP COLUMN "pausedMs",
ADD COLUMN     "pausedSeconds" INTEGER NOT NULL DEFAULT 0;
