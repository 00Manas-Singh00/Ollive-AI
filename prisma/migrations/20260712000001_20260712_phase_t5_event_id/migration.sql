-- AlterTable
ALTER TABLE "InferenceLog" ADD COLUMN "eventId" TEXT;

-- Backfill (table is empty in every environment we've verified; this is a safety net)
UPDATE "InferenceLog" SET "eventId" = "id" WHERE "eventId" IS NULL;

-- AlterTable
ALTER TABLE "InferenceLog" ALTER COLUMN "eventId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "InferenceLog_eventId_key" ON "InferenceLog"("eventId");
