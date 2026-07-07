-- CreateEnum
CREATE TYPE "InsightStatus" AS ENUM ('PENDING', 'SENT', 'DISMISSED');

-- CreateTable
CREATE TABLE "ProactiveInsight" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "triggerReason" TEXT NOT NULL,
    "suggestedMessage" TEXT NOT NULL,
    "relatedConversationIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "InsightStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProactiveInsight_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ProactiveInsight_userId_status_createdAt_idx" ON "ProactiveInsight"("userId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "ProactiveInsight" ADD CONSTRAINT "ProactiveInsight_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
