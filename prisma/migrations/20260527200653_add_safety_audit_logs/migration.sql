-- CreateTable
CREATE TABLE "SafetyAuditLog" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "phase" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "reason" TEXT,
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "sample" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SafetyAuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SafetyAuditLog_conversationId_createdAt_idx" ON "SafetyAuditLog"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "SafetyAuditLog_phase_action_createdAt_idx" ON "SafetyAuditLog"("phase", "action", "createdAt");

-- AddForeignKey
ALTER TABLE "SafetyAuditLog" ADD CONSTRAINT "SafetyAuditLog_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
