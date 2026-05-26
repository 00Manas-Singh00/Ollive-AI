-- AlterTable
ALTER TABLE "InferenceLog" ADD COLUMN     "mode" TEXT,
ADD COLUMN     "streamDurationMs" INTEGER,
ADD COLUMN     "ttftMs" INTEGER;

-- CreateTable
CREATE TABLE "IngestionEvent" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "IngestionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionDLQ" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "retryCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IngestionDLQ_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "IngestionEvent_conversationId_createdAt_idx" ON "IngestionEvent"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "IngestionDLQ_eventId_idx" ON "IngestionDLQ"("eventId");

-- CreateIndex
CREATE INDEX "IngestionDLQ_conversationId_createdAt_idx" ON "IngestionDLQ"("conversationId", "createdAt");
