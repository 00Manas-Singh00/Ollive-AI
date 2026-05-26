-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "folder" TEXT,
ADD COLUMN     "isArchived" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "isPinned" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateIndex
CREATE INDEX "Conversation_isArchived_isPinned_updatedAt_idx" ON "Conversation"("isArchived", "isPinned", "updatedAt");
