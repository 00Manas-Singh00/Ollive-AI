-- CreateTable
CREATE TABLE "MessageAnnotation" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "rating" INTEGER,
    "thumbs" TEXT,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MessageAnnotation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MessageAnnotation_messageId_idx" ON "MessageAnnotation"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "MessageAnnotation_messageId_userId_key" ON "MessageAnnotation"("messageId", "userId");

-- AddForeignKey
ALTER TABLE "MessageAnnotation" ADD CONSTRAINT "MessageAnnotation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MessageAnnotation" ADD CONSTRAINT "MessageAnnotation_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
