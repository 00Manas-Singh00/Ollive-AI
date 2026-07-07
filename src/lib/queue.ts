import { Queue } from "bullmq";

let cachedQueue: Queue | null = null;
let cachedQualityScoreQueue: Queue | null = null;
let cachedAmbientInsightQueue: Queue | null = null;

export function getIngestQueue(): Queue {
  if (cachedQueue) return cachedQueue;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is not configured");
  }

  cachedQueue = new Queue("inference-ingest", {
    connection: { url: redisUrl },
    defaultJobOptions: {
      attempts: Number(process.env.INGEST_MAX_RETRIES || 5),
      backoff: {
        type: "exponential",
        delay: Number(process.env.INGEST_RETRY_DELAY_MS || 1000),
      },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

  return cachedQueue;
}

export function getQualityScoreQueue(): Queue {
  if (cachedQualityScoreQueue) return cachedQualityScoreQueue;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is not configured");
  }

  cachedQualityScoreQueue = new Queue("quality-score-queue", {
    connection: { url: redisUrl },
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

  return cachedQualityScoreQueue;
}

export function getAmbientInsightQueue(): Queue {
  if (cachedAmbientInsightQueue) return cachedAmbientInsightQueue;

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is not configured");
  }

  cachedAmbientInsightQueue = new Queue("ambient-insight-queue", {
    connection: { url: redisUrl },
    defaultJobOptions: {
      attempts: 2,
      backoff: { type: "exponential", delay: 5000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  });

  return cachedAmbientInsightQueue;
}
