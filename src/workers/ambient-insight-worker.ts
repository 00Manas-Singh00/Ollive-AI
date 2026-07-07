import { Worker } from "bullmq";
import { getAmbientInsightQueue } from "@/lib/queue";
import { findActiveUserIds, generateInsightForUser } from "@/lib/ambient-insights";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not configured");
}

// How often the scan runs (minutes). Scheduled via a BullMQ repeatable job rather than
// triggered per-request, so insights accrue in the background.
const SCAN_INTERVAL_MINUTES = Math.max(1, Number(process.env.AMBIENT_INSIGHT_INTERVAL_MINUTES ?? 60) || 60);

type JobData = { type: "scan" } | { type: "user"; userId: string };

const worker = new Worker<JobData>(
  "ambient-insight-queue",
  async (job) => {
    if (job.data.type === "scan") {
      const userIds = await findActiveUserIds();
      const queue = getAmbientInsightQueue();
      // Fan out one job per active user so a slow LLM call for one user doesn't block others.
      await Promise.all(
        userIds.map((userId) => queue.add("user", { type: "user", userId } satisfies JobData)),
      );
      return { scanned: userIds.length };
    }

    const insightId = await generateInsightForUser(job.data.userId);
    return { insightId };
  },
  { connection: { url: redisUrl }, concurrency: Number(process.env.AMBIENT_INSIGHT_CONCURRENCY || 2) },
);

worker.on("completed", (job) => {
  console.log(`[ambient-insight-worker] completed job ${job.id} (${JSON.stringify(job.returnvalue)})`);
});

worker.on("failed", (job, err) => {
  console.error(`[ambient-insight-worker] failed job ${job?.id}:`, err.message);
});

async function bootstrap() {
  const queue = getAmbientInsightQueue();
  // Register the repeatable scan. Re-adding with the same job id is idempotent.
  await queue.add(
    "scan",
    { type: "scan" } satisfies JobData,
    {
      repeat: { every: SCAN_INTERVAL_MINUTES * 60 * 1000 },
      jobId: "ambient-insight-scan",
    },
  );
  console.log(`[ambient-insight-worker] worker started; scanning every ${SCAN_INTERVAL_MINUTES}m`);
}

void bootstrap();
