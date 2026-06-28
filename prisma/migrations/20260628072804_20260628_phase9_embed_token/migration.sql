-- CreateTable
CREATE TABLE "EmbedToken" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT,
    "promptProfileKey" TEXT,
    "allowedOrigins" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmbedToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EmbedToken_token_key" ON "EmbedToken"("token");

-- CreateIndex
CREATE INDEX "EmbedToken_userId_idx" ON "EmbedToken"("userId");

-- AddForeignKey
ALTER TABLE "EmbedToken" ADD CONSTRAINT "EmbedToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
