import Redis from "ioredis";
import { prisma } from "@/lib/prisma";
import { calculateCostUsd } from "@/lib/cost";
import { PROVIDER_NAMES, type ProviderName } from "@/lib/llm";

let cachedClient: Redis | null = null;

function getRedis(): Redis | null {
  if (cachedClient) return cachedClient;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;
  cachedClient = new Redis(redisUrl);
  return cachedClient;
}

// Spend keys are month-scoped ("YYYY-MM") so rollover is automatic.
export function currentMonth(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function spendKey(userId: string, month: string): string {
  return `spend:${userId}:${month}`;
}

export type BudgetStatus = {
  status: "ok" | "warning" | "exceeded";
  spendUsd: number;
  budgetUsd: number | null;
  action: "WARN" | "DOWNGRADE" | "BLOCK";
};

const WARNING_THRESHOLD = 0.8;

// Called from the ingest worker only — never from the request path.
export async function recordSpend(
  userId: string,
  provider: string,
  model: string,
  tokensIn: number,
  tokensOut: number,
): Promise<void> {
  const costUsd = calculateCostUsd(provider, model, tokensIn, tokensOut);
  if (costUsd <= 0) return;

  const month = currentMonth();

  const row = await prisma.spendCache.upsert({
    where: { userId_month: { userId, month } },
    create: { userId, month, spendUsd: costUsd },
    update: { spendUsd: { increment: costUsd } },
  });

  // Mirror the authoritative DB total into Redis for a cheap hot-path read.
  // SET (not INCRBYFLOAT) so the cache can never drift from the DB.
  const redis = getRedis();
  if (redis) {
    // Expire safely past month end so stale months clean themselves up.
    await redis.set(spendKey(userId, month), String(row.spendUsd), "EX", 40 * 24 * 3600);
  }
}

async function readSpend(userId: string): Promise<number> {
  const month = currentMonth();
  const redis = getRedis();

  if (redis) {
    const cached = await redis.get(spendKey(userId, month));
    if (cached !== null) return Number(cached) || 0;
  }

  // Redis miss: rebuild from SpendCache (never from scanning InferenceLog).
  const row = await prisma.spendCache.findUnique({
    where: { userId_month: { userId, month } },
  });
  const spendUsd = row?.spendUsd ?? 0;
  if (redis) {
    const key = spendKey(userId, month);
    await redis.set(key, String(spendUsd), "EX", 40 * 24 * 3600);
  }
  return spendUsd;
}

export async function checkBudget(userId: string): Promise<BudgetStatus> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { monthlyBudgetUsd: true, budgetAction: true },
  });
  const budgetUsd = user?.monthlyBudgetUsd ?? null;
  const action = user?.budgetAction ?? "WARN";

  if (budgetUsd === null || budgetUsd <= 0) {
    return { status: "ok", spendUsd: await readSpend(userId), budgetUsd, action };
  }

  const spendUsd = await readSpend(userId);
  const status =
    spendUsd >= budgetUsd ? "exceeded" : spendUsd >= budgetUsd * WARNING_THRESHOLD ? "warning" : "ok";
  return { status, spendUsd, budgetUsd, action };
}

// Maps any provider/model to the configured cheap fallback used when a
// DOWNGRADE budget action fires (env BUDGET_FALLBACK_PROVIDER / BUDGET_FALLBACK_MODEL).
export function downgradeProvider(): { provider: ProviderName; model?: string } {
  const raw = (process.env.BUDGET_FALLBACK_PROVIDER || "gemini").toLowerCase() as ProviderName;
  const provider = PROVIDER_NAMES.includes(raw) ? raw : "gemini";
  return { provider, model: process.env.BUDGET_FALLBACK_MODEL || undefined };
}
