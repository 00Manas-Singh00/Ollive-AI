// Backfill script for Phase 16: enqueues every conversation with at least one
// un-embedded message through embedding-queue, so the embedding worker (which
// must be running) does the actual work in batches.
//
// Usage: node scripts/backfill-embeddings.mjs
import { PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  console.error("REDIS_URL is not configured");
  process.exit(1);
}

const prisma = new PrismaClient();
const queue = new Queue("embedding-queue", { connection: { url: redisUrl } });

const conversations = await prisma.conversation.findMany({
  where: { messages: { some: { embedding: null } } },
  select: { id: true },
});

for (const { id } of conversations) {
  // jobId dedupes re-runs of the backfill while a prior job is still queued
  await queue.add("embed", { conversationId: id }, { jobId: `backfill-${id}` });
}

console.log(`[backfill-embeddings] enqueued ${conversations.length} conversation(s)`);

await queue.close();
await prisma.$disconnect();
