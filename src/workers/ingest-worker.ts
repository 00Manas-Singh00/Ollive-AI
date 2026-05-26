import { Worker, QueueEvents, Queue } from "bullmq";
import { prisma } from "@/lib/prisma";
import { logSchema, type IngestPayload } from "@/lib/ingest-schema";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not configured");
}

type JobData = {
  eventId: string;
  payload: IngestPayload;
};

const worker = new Worker<JobData>(
  "inference-ingest",
  async (job) => {
    const payload = logSchema.parse(job.data.payload);

    const existing = await prisma.ingestionEvent.findUnique({
      where: { id: job.data.eventId },
    });

    if (existing?.status === "processed") {
      return;
    }

    if (!existing) {
      await prisma.ingestionEvent.create({
        data: {
          id: job.data.eventId,
          conversationId: payload.conversationId,
          status: "processing",
        },
      });
    }

    await prisma.inferenceLog.create({
      data: {
        conversationId: payload.conversationId,
        provider: payload.provider,
        model: payload.model,
        status: payload.status,
        mode: payload.mode,
        latencyMs: payload.latencyMs,
        ttftMs: payload.ttftMs,
        streamDurationMs: payload.streamDurationMs,
        promptTokens: payload.promptTokens,
        completionTokens: payload.completionTokens,
        totalTokens: payload.totalTokens,
        requestTs: new Date(payload.requestTs),
        responseTs: new Date(payload.responseTs),
        inputPreview: payload.inputPreview,
        outputPreview: payload.outputPreview,
        errorMessage: payload.errorMessage,
      },
    });

    await prisma.ingestionEvent.upsert({
      where: { id: job.data.eventId },
      create: {
        id: job.data.eventId,
        conversationId: payload.conversationId,
        status: "processed",
        processedAt: new Date(),
      },
      update: {
        status: "processed",
        processedAt: new Date(),
      },
    });
  },
  { connection: { url: redisUrl } }
);

const queueEvents = new QueueEvents("inference-ingest", {
  connection: { url: redisUrl },
});
const ingestQueue = new Queue("inference-ingest", {
  connection: { url: redisUrl },
});

queueEvents.on("failed", async ({ jobId, failedReason }) => {
  if (!jobId) return;
  const job = await ingestQueue.getJob(jobId);
  if (!job) return;

  const maxRetries = Number(process.env.INGEST_MAX_RETRIES || 5);
  const attempts = job.attemptsMade;

  if (attempts < maxRetries) {
    return;
  }

  const payload = (job.data as JobData).payload;

  await prisma.ingestionEvent.upsert({
    where: { id: (job.data as JobData).eventId },
    create: {
      id: (job.data as JobData).eventId,
      conversationId: payload.conversationId,
      status: "failed",
    },
    update: { status: "failed" },
  });

  await prisma.ingestionDLQ.create({
    data: {
      eventId: (job.data as JobData).eventId,
      conversationId: payload.conversationId,
      payload: JSON.stringify(payload),
      reason: failedReason || "Unknown failure",
      retryCount: attempts,
    },
  });
});

worker.on("completed", (job) => {
  console.log(`[ingest-worker] completed job ${job.id}`);
});

worker.on("failed", (job, err) => {
  console.error(`[ingest-worker] failed job ${job?.id}:`, err.message);
});

console.log("[ingest-worker] worker started");
