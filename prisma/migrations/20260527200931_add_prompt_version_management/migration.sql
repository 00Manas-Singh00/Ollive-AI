-- CreateTable
CREATE TABLE "PromptProfile" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "description" TEXT,
    "activeVersion" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "basePrompt" TEXT NOT NULL,
    "variantA" TEXT,
    "variantB" TEXT,
    "abRatioA" INTEGER NOT NULL DEFAULT 50,
    "modelOverrides" JSONB,
    "isRollbackPoint" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptDecision" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "variant" TEXT NOT NULL,
    "model" TEXT,
    "resolvedPrompt" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptDecision_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PromptProfile_key_key" ON "PromptProfile"("key");

-- CreateIndex
CREATE INDEX "PromptProfile_key_activeVersion_idx" ON "PromptProfile"("key", "activeVersion");

-- CreateIndex
CREATE INDEX "PromptVersion_profileId_createdAt_idx" ON "PromptVersion"("profileId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_profileId_version_key" ON "PromptVersion"("profileId", "version");

-- CreateIndex
CREATE INDEX "PromptDecision_conversationId_createdAt_idx" ON "PromptDecision"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "PromptDecision_profileKey_version_variant_idx" ON "PromptDecision"("profileKey", "version", "variant");

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "PromptProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptDecision" ADD CONSTRAINT "PromptDecision_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
