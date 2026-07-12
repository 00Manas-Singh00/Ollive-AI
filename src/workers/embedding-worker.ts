import { Worker } from "bullmq";
import { prisma } from "@/lib/prisma";
import { embedText } from "@/lib/rag";

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

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

      const embeddedMessages = await Promise.all(messages.map(async (m) => ({ ...m, ...(await embedText(m.content)) })));

      // Individual creates inside skipDuplicates-style guard: another job for the
      // same conversation may race; the @unique(messageId) makes this idempotent.
      await prisma.messageEmbedding.createMany({
        data: embeddedMessages.map((m) => ({
          messageId: m.id,
          vector: m.vector,
          model: m.model,
        })),
        skipDuplicates: true,
      });

      await Promise.all(
        embeddedMessages
          .filter((m) => m.realVector)
          .map((m) =>
            prisma.$executeRawUnsafe(
              `UPDATE "MessageEmbedding" SET "embeddingVector" = $1::vector WHERE "messageId" = $2`,
              toVectorLiteral(m.realVector!),
              m.id,
            ),
          ),
      );

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
