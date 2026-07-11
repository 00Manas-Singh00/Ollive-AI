import { Worker } from "bullmq";
import { prisma } from "@/lib/prisma";
import { callLLMWithLogging } from "@/lib/llm";
import type { ProviderName } from "@/lib/llm";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not configured");
}

// How many of the user's other recent conversations to summarize as context for
// the scheduled prompt (e.g. "summarize my week's conversations").
const CONTEXT_CONVERSATIONS = Math.max(0, Number(process.env.SCHEDULED_PROMPT_CONTEXT_CONVERSATIONS ?? 5) || 5);

type JobData = { scheduleId: string };

async function buildContext(userId: string): Promise<string> {
  const conversations = await prisma.conversation.findMany({
    where: { userId, isArchived: false },
    orderBy: { updatedAt: "desc" },
    take: CONTEXT_CONVERSATIONS,
    select: {
      title: true,
      messages: { orderBy: { createdAt: "desc" }, take: 4, select: { role: true, content: true } },
    },
  });
  if (conversations.length === 0) return "";

  const summary = conversations
    .map((c) => {
      const lines = c.messages
        .slice()
        .reverse()
        .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
        .join("\n");
      return `## ${c.title}\n${lines}`;
    })
    .join("\n\n");

  return `Recent conversation context:\n\n${summary}`;
}

const worker = new Worker<JobData>(
  "scheduled-prompt-queue",
  async (job) => {
    // The worker runs with no session — every query is scoped to the schedule's
    // own userId, never trusting caller-provided identity.
    const schedule = await prisma.scheduledPrompt.findUnique({ where: { id: job.data.scheduleId } });
    if (!schedule || !schedule.isActive) return { skipped: true };

    let conversationId = schedule.deliveryConversationId;
    if (!conversationId) {
      const conversation = await prisma.conversation.create({
        data: { userId: schedule.userId, title: schedule.prompt.slice(0, 50) },
      });
      conversationId = conversation.id;
      await prisma.scheduledPrompt.update({ where: { id: schedule.id }, data: { deliveryConversationId: conversationId } });
    }

    const context = await buildContext(schedule.userId);
    const userTurn = context ? `${context}\n\n---\n\n${schedule.prompt}` : schedule.prompt;

    await prisma.chatMessage.create({ data: { conversationId, role: "user", content: schedule.prompt } });

    const result = await callLLMWithLogging({
      conversationId,
      messages: [
        { role: "system", content: "You are a helpful assistant generating a scheduled digest for the user." },
        { role: "user", content: userTurn },
      ],
      providerOverride: schedule.provider as ProviderName,
    });

    await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: result.output } });
    await prisma.scheduledPrompt.update({ where: { id: schedule.id }, data: { lastRunAt: new Date() } });

    return { conversationId };
  },
  { connection: { url: redisUrl }, concurrency: Number(process.env.SCHEDULED_PROMPT_CONCURRENCY || 2) },
);

worker.on("completed", (job) => {
  console.log(`[scheduled-prompt-worker] completed job ${job.id} (${JSON.stringify(job.returnvalue)})`);
});

worker.on("failed", (job, err) => {
  console.error(`[scheduled-prompt-worker] failed job ${job?.id}:`, err.message);
});

console.log("[scheduled-prompt-worker] worker started");
