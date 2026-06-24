import Redis from "ioredis";

let cachedClient: Redis | null = null;

function getRedis(): Redis {
  if (cachedClient) return cachedClient;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is not configured");
  cachedClient = new Redis(redisUrl);
  return cachedClient;
}

const WINDOWS = [
  { key: "minute", seconds: 60, limitEnv: "RATE_LIMIT_PER_MINUTE", defaultLimit: 20 },
  { key: "hour", seconds: 3600, limitEnv: "RATE_LIMIT_PER_HOUR", defaultLimit: 200 },
  { key: "day", seconds: 86400, limitEnv: "RATE_LIMIT_PER_DAY", defaultLimit: 1000 },
] as const;

export interface RateLimitResult {
  limited: boolean;
  limit: number;
  remaining: number;
  windowSeconds: number;
}

export async function checkRateLimit(userId: string): Promise<RateLimitResult> {
  const redis = getRedis();

  for (const window of WINDOWS) {
    const limit = Number(process.env[window.limitEnv] ?? window.defaultLimit) || window.defaultLimit;
    const key = `ratelimit:${userId}:${window.key}`;

    const count = await redis.incr(key);
    if (count === 1) {
      await redis.expire(key, window.seconds);
    }

    if (count > limit) {
      return { limited: true, limit, remaining: 0, windowSeconds: window.seconds };
    }
  }

  const minuteLimit = Number(process.env.RATE_LIMIT_PER_MINUTE ?? 20) || 20;
  const minuteCount = await redis.get(`ratelimit:${userId}:minute`);
  return {
    limited: false,
    limit: minuteLimit,
    remaining: Math.max(0, minuteLimit - Number(minuteCount ?? 0)),
    windowSeconds: 60,
  };
}
