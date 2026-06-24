-- CreateTable
CREATE TABLE "QualityScore" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "breakdown" JSONB NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QualityScore_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "QualityScore_messageId_key" ON "QualityScore"("messageId");

-- CreateIndex
CREATE INDEX "QualityScore_score_idx" ON "QualityScore"("score");

-- AddForeignKey
ALTER TABLE "QualityScore" ADD CONSTRAINT "QualityScore_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
