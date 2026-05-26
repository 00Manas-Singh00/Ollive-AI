import { Queue } from "bullmq";

const redisUrl = process.env.REDIS_URL;

if (!redisUrl) {
  throw new Error("REDIS_URL is not configured");
}

export const ingestQueue = new Queue("inference-ingest", {
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
