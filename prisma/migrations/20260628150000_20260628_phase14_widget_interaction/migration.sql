-- CreateTable
CREATE TABLE "WidgetInteraction" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "widgetType" TEXT NOT NULL,
    "schema" JSONB NOT NULL,
    "userResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WidgetInteraction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WidgetInteraction_messageId_key" ON "WidgetInteraction"("messageId");

-- AddForeignKey
ALTER TABLE "WidgetInteraction" ADD CONSTRAINT "WidgetInteraction_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ChatMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
