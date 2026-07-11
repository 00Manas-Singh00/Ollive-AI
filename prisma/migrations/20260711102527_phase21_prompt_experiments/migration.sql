-- CreateEnum
CREATE TYPE "PromptExperimentStatus" AS ENUM ('RUNNING', 'CONCLUDED_CHAMPION', 'CONCLUDED_CHALLENGER', 'ABORTED');

-- CreateTable
CREATE TABLE "PromptExperiment" (
    "id" TEXT NOT NULL,
    "profileKey" TEXT NOT NULL,
    "championVersionId" TEXT NOT NULL,
    "challengerVersionId" TEXT NOT NULL,
    "trafficSplit" DOUBLE PRECISION NOT NULL DEFAULT 0.1,
    "status" "PromptExperimentStatus" NOT NULL DEFAULT 'RUNNING',
    "minSamples" INTEGER NOT NULL DEFAULT 100,
    "autoPromote" BOOLEAN NOT NULL DEFAULT false,
    "metrics" JSONB,
    "concludedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromptExperiment_profileKey_status_idx" ON "PromptExperiment"("profileKey", "status");

-- AddForeignKey
ALTER TABLE "PromptExperiment" ADD CONSTRAINT "PromptExperiment_championVersionId_fkey" FOREIGN KEY ("championVersionId") REFERENCES "PromptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptExperiment" ADD CONSTRAINT "PromptExperiment_challengerVersionId_fkey" FOREIGN KEY ("challengerVersionId") REFERENCES "PromptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
