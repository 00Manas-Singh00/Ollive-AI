-- CreateTable
CREATE TABLE "ScheduledPrompt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "cronExpression" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastRunAt" TIMESTAMP(3),
    "deliveryConversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ScheduledPrompt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ScheduledPrompt_userId_isActive_idx" ON "ScheduledPrompt"("userId", "isActive");

-- AddForeignKey
ALTER TABLE "ScheduledPrompt" ADD CONSTRAINT "ScheduledPrompt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
