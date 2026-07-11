-- CreateEnum
CREATE TYPE "BudgetAction" AS ENUM ('WARN', 'DOWNGRADE', 'BLOCK');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "budgetAction" "BudgetAction" NOT NULL DEFAULT 'WARN',
ADD COLUMN     "monthlyBudgetUsd" DOUBLE PRECISION;

-- CreateTable
CREATE TABLE "SpendCache" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "spendUsd" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "SpendCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SpendCache_userId_month_key" ON "SpendCache"("userId", "month");
