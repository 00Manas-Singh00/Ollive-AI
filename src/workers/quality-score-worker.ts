import { Worker } from "bullmq";
import { prisma } from "@/lib/prisma";
import { scoreResponseSmart } from "@/lib/quality-scorer";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not configured");
}

type JobData = {
  messageId: string;
};

const worker = new Worker<JobData>(
  "quality-score-queue",
  async (job) => {
    const message = await prisma.chatMessage.findUnique({ where: { id: job.data.messageId } });
    if (!message || message.role !== "assistant") return;

    const precedingUserMessage = await prisma.chatMessage.findFirst({
      where: { conversationId: message.conversationId, role: "user", createdAt: { lt: message.createdAt } },
      orderBy: { createdAt: "desc" },
    });

    const result = await scoreResponseSmart(precedingUserMessage?.content ?? "", message.content);

    await prisma.qualityScore.upsert({
      where: { messageId: message.id },
      create: {
        messageId: message.id,
        score: result.score,
        breakdown: result.breakdown,
        reason: result.reason,
      },
      update: {
        score: result.score,
        breakdown: result.breakdown,
        reason: result.reason,
      },
    });
  },
  { connection: { url: redisUrl } }
);

worker.on("completed", (job) => {
  console.log(`[quality-score-worker] completed job ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[quality-score-worker] failed job ${job?.id}:`, err.message);
});

console.log("[quality-score-worker] worker started");
