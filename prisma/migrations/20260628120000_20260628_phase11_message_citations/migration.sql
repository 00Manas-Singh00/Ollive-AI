-- CreateTable
CREATE TABLE "MessageCitation" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "chunkId" TEXT NOT NULL,
    "relevanceScore" DOUBLE PRECISION NOT NULL,
    "excerptStart" INTEGER NOT NULL,
    "excerptEnd" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MessageCitation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageCitation_messageId_idx" ON "MessageCitation"("messageId");

-- CreateIndex
CREATE INDEX "MessageCitation_chunkId_idx" ON "MessageCitation"("chunkId");

-- AddForeignKey
ALTER TABLE "MessageCitation" ADD CONSTRAINT "MessageCitation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageCitation" ADD CONSTRAINT "MessageCitation_chunkId_fkey" FOREIGN KEY ("chunkId") REFERENCES "KnowledgeChunk"("id") ON DELETE CASCADE ON UPDATE CASCADE;
