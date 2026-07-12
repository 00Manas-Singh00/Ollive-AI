-- Enable pgvector
CREATE EXTENSION IF NOT EXISTS vector;

-- AlterTable
ALTER TABLE "KnowledgeChunk" ADD COLUMN "embeddingVector" vector(768);
ALTER TABLE "MessageEmbedding" ADD COLUMN "embeddingVector" vector(768);

-- CreateIndex (approximate nearest-neighbor, cosine distance)
CREATE INDEX "KnowledgeChunk_embeddingVector_idx" ON "KnowledgeChunk" USING ivfflat ("embeddingVector" vector_cosine_ops) WITH (lists = 100);
CREATE INDEX "MessageEmbedding_embeddingVector_idx" ON "MessageEmbedding" USING ivfflat ("embeddingVector" vector_cosine_ops) WITH (lists = 100);
