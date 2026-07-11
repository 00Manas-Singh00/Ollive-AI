import { Worker } from "bullmq";
import { prisma } from "@/lib/prisma";
import { embedText, EMBEDDING_MODEL } from "@/lib/rag";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not configured");
}

// Messages embedded per job so a huge backfilled conversation is processed in
// bounded batches; the loop drains until the conversation is fully embedded.
const BATCH_SIZE = Math.max(1, Number(process.env.EMBEDDING_BATCH_SIZE ?? 50) || 50);

type JobData = { conversationId: string };

const worker = new Worker<JobData>(
  "embedding-queue",
  async (job) => {
    const { conversationId } = job.data;
    let embedded = 0;

    for (;;) {
      const messages = await prisma.chatMessage.findMany({
        where: { conversationId, embedding: null },
        orderBy: { createdAt: "asc" },
        take: BATCH_SIZE,
        select: { id: true, content: true },
      });
      if (messages.length === 0) break;

      // Individual creates inside skipDuplicates-style guard: another job for the
      // same conversation may race; the @unique(messageId) makes this idempotent.
      await prisma.messageEmbedding.createMany({
        data: messages.map((m) => ({
          messageId: m.id,
          vector: embedText(m.content),
          model: EMBEDDING_MODEL,
        })),
        skipDuplicates: true,
      });

      embedded += messages.length;
      if (messages.length < BATCH_SIZE) break;
    }

    return { conversationId, embedded };
  },
  { connection: { url: redisUrl }, concurrency: Number(process.env.EMBEDDING_CONCURRENCY || 4) },
);

worker.on("completed", (job) => {
  console.log(`[embedding-worker] completed job ${job.id} (${JSON.stringify(job.returnvalue)})`);
});

worker.on("failed", (job, err) => {
  console.error(`[embedding-worker] failed job ${job?.id}:`, err.message);
});

console.log("[embedding-worker] worker started");
