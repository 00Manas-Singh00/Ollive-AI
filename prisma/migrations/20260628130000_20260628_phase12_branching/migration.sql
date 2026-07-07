-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN "rootConversationId" TEXT;

-- AlterTable
ALTER TABLE "ChatMessage" ADD COLUMN "branchParentId" TEXT;

-- CreateIndex
CREATE INDEX "ChatMessage_branchParentId_idx" ON "ChatMessage"("branchParentId");

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_branchParentId_fkey" FOREIGN KEY ("branchParentId") REFERENCES "ChatMessage"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;
