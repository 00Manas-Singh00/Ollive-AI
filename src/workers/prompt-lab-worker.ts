import { Worker } from "bullmq";
import { prisma } from "@/lib/prisma";
import { getPromptLabQueue } from "@/lib/queue";
import { evaluateExperiment, promoteWinner } from "@/lib/prompt-lab";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is not configured");
}

// How often running experiments are re-evaluated (minutes).
const EVAL_INTERVAL_MINUTES = Math.max(1, Number(process.env.PROMPT_LAB_INTERVAL_MINUTES ?? 60) || 60);

type JobData = { type: "scan" } | { type: "evaluate"; experimentId: string };

const worker = new Worker<JobData>(
  "prompt-lab-queue",
  async (job) => {
    if (job.data.type === "scan") {
      const running = await prisma.promptExperiment.findMany({ where: { status: "RUNNING" }, select: { id: true } });
      const queue = getPromptLabQueue();
      await Promise.all(
        running.map((experiment) => queue.add("evaluate", { type: "evaluate", experimentId: experiment.id } satisfies JobData)),
      );
      return { scanned: running.length };
    }

    const evaluation = await evaluateExperiment(job.data.experimentId);
    if (evaluation.readyToConclude) {
      await promoteWinner(job.data.experimentId, evaluation);
      return { concluded: true, winner: evaluation.winner };
    }

    // Not significant yet — persist the latest metrics snapshot so the admin UI has fresh numbers.
    await prisma.promptExperiment.update({
      where: { id: job.data.experimentId },
      data: { metrics: evaluation as unknown as object },
    });
    return { concluded: false };
  },
  { connection: { url: redisUrl }, concurrency: Number(process.env.PROMPT_LAB_CONCURRENCY || 2) },
);

worker.on("completed", (job) => {
  console.log(`[prompt-lab-worker] completed job ${job.id} (${JSON.stringify(job.returnvalue)})`);
});

worker.on("failed", (job, err) => {
  console.error(`[prompt-lab-worker] failed job ${job?.id}:`, err.message);
});

async function bootstrap() {
  const queue = getPromptLabQueue();
  await queue.add(
    "scan",
    { type: "scan" } satisfies JobData,
    {
      repeat: { every: EVAL_INTERVAL_MINUTES * 60 * 1000 },
      jobId: "prompt-lab-scan",
    },
  );
  console.log(`[prompt-lab-worker] worker started; evaluating every ${EVAL_INTERVAL_MINUTES}m`);
}

void bootstrap();
