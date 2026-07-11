import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { callLLMWithLogging } from "@/lib/llm";

export const MAX_TRAFFIC_SPLIT = 0.5;

function stablePercent(seed: string): number {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const num = Number.parseInt(hex, 16);
  return num % 100;
}

export type ExperimentArm = "champion" | "challenger";

export async function getRunningExperiment(profileKey: string) {
  return prisma.promptExperiment.findFirst({
    where: { profileKey, status: "RUNNING" },
    include: { championVersion: true, challengerVersion: true },
  });
}

/** Deterministic hash bucket so a given user/conversation stays in one arm for the life of the experiment. */
export function pickArmForRequest(experimentId: string, seed: string, trafficSplit: number): ExperimentArm {
  const pct = stablePercent(`${experimentId}:${seed}`);
  return pct < trafficSplit * 100 ? "challenger" : "champion";
}

type ArmStats = {
  total: number;
  thumbsUp: number;
  thumbsDown: number;
  qualitySum: number;
  qualityCount: number;
  refusals: number;
};

function emptyStats(): ArmStats {
  return { total: 0, thumbsUp: 0, thumbsDown: 0, qualitySum: 0, qualityCount: 0, refusals: 0 };
}

async function collectArmStats(profileKey: string, version: number, since: Date): Promise<ArmStats> {
  const decisions = await prisma.promptDecision.findMany({
    where: { profileKey, version, createdAt: { gte: since } },
    select: { conversationId: true, createdAt: true },
  });

  const stats = emptyStats();

  for (const decision of decisions) {
    const assistantMessage = await prisma.chatMessage.findFirst({
      where: { conversationId: decision.conversationId, role: "assistant", createdAt: { gte: decision.createdAt } },
      orderBy: { createdAt: "asc" },
      include: { qualityScore: true, annotations: true },
    });
    if (!assistantMessage) continue;

    stats.total += 1;
    for (const annotation of assistantMessage.annotations) {
      if (annotation.thumbs === "up") stats.thumbsUp += 1;
      if (annotation.thumbs === "down") stats.thumbsDown += 1;
    }
    if (assistantMessage.qualityScore) {
      stats.qualitySum += assistantMessage.qualityScore.score;
      stats.qualityCount += 1;
    }

    const refusal = await prisma.safetyAuditLog.findFirst({
      where: { conversationId: decision.conversationId, phase: "output", action: "blocked", createdAt: { gte: decision.createdAt } },
      select: { id: true },
    });
    if (refusal) stats.refusals += 1;
  }

  return stats;
}

/** Composite "good outcome" = thumbs-up, or a decent quality score, and no refusal. */
function successRate(stats: ArmStats): number {
  if (stats.total === 0) return 0;
  let successes = 0;
  const avgQuality = stats.qualityCount > 0 ? stats.qualitySum / stats.qualityCount : null;
  if (stats.thumbsUp > 0 || stats.thumbsDown > 0) {
    successes = stats.thumbsUp;
    return successes / (stats.thumbsUp + stats.thumbsDown || 1);
  }
  if (avgQuality !== null) {
    return avgQuality >= 60 ? 1 - stats.refusals / stats.total : 0.3;
  }
  return stats.refusals > 0 ? 0 : 0.5;
}

/** Two-proportion z-test, hand-rolled (no new dependency). Returns null if either sample is too small. */
function twoProportionZTest(p1: number, n1: number, p2: number, n2: number): number | null {
  if (n1 === 0 || n2 === 0) return null;
  const pooled = (p1 * n1 + p2 * n2) / (n1 + n2);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n1 + 1 / n2));
  if (se === 0) return null;
  return (p1 - p2) / se;
}

export type ExperimentEvaluation = {
  champion: ArmStats & { successRate: number };
  challenger: ArmStats & { successRate: number };
  z: number | null;
  significant: boolean;
  readyToConclude: boolean;
  winner: ExperimentArm | null;
};

export async function evaluateExperiment(experimentId: string): Promise<ExperimentEvaluation> {
  const experiment = await prisma.promptExperiment.findUnique({
    where: { id: experimentId },
    include: { championVersion: true, challengerVersion: true },
  });
  if (!experiment) throw new Error("Experiment not found");

  const [championStats, challengerStats] = await Promise.all([
    collectArmStats(experiment.profileKey, experiment.championVersion.version, experiment.createdAt),
    collectArmStats(experiment.profileKey, experiment.challengerVersion.version, experiment.createdAt),
  ]);

  const championRate = successRate(championStats);
  const challengerRate = successRate(challengerStats);
  const z = twoProportionZTest(challengerRate, challengerStats.total, championRate, championStats.total);
  const significant = z !== null && Math.abs(z) >= 1.96;
  const readyToConclude = championStats.total >= experiment.minSamples && challengerStats.total >= experiment.minSamples && significant;
  const winner: ExperimentArm | null = readyToConclude ? (z! > 0 ? "challenger" : "champion") : null;

  return {
    champion: { ...championStats, successRate: championRate },
    challenger: { ...challengerStats, successRate: challengerRate },
    z,
    significant,
    readyToConclude,
    winner,
  };
}

const CHALLENGER_META_PROMPT = `You improve system prompts for an AI chat assistant. Given the current system prompt below, propose a single mutated variant that could perform better — sharpen clarity, tighten brevity, or add a useful constraint. Do not change the fundamental purpose of the prompt. Respond with ONLY the new prompt text, no commentary, no markdown fences.

Current prompt:
"""
{{PROMPT}}
"""`;

export async function generateChallenger(profileKey: string) {
  const profile = await prisma.promptProfile.findUnique({ where: { key: profileKey } });
  if (!profile) throw new Error("Profile not found");

  const activeVersion = await prisma.promptVersion.findFirst({
    where: { profileId: profile.id, version: profile.activeVersion ?? 1 },
  });
  if (!activeVersion) throw new Error("Active version not found");

  // The meta-prompt call needs a conversationId to satisfy InferenceLog's FK; there is no
  // real conversation for this admin action, so anchor to any existing one (mirrors the
  // sentinel pattern used by the admin prompt-activate route).
  const anchorConversation = await prisma.conversation.findFirst({ select: { id: true } });
  if (!anchorConversation) throw new Error("No conversation available to anchor the challenger-generation log");

  const result = await callLLMWithLogging({
    conversationId: anchorConversation.id,
    messages: [{ role: "user", content: CHALLENGER_META_PROMPT.replace("{{PROMPT}}", activeVersion.basePrompt) }],
  });

  const latest = await prisma.promptVersion.findFirst({ where: { profileId: profile.id }, orderBy: { version: "desc" } });
  const nextVersion = (latest?.version ?? 0) + 1;

  return prisma.promptVersion.create({
    data: {
      profileId: profile.id,
      version: nextVersion,
      basePrompt: result.output.trim(),
      modelOverrides: {},
      isRollbackPoint: false,
    },
  });
}

export async function abortExperiment(experimentId: string) {
  return prisma.promptExperiment.update({
    where: { id: experimentId },
    data: { status: "ABORTED", concludedAt: new Date() },
  });
}

export async function promoteWinner(experimentId: string, evaluation: ExperimentEvaluation) {
  const experiment = await prisma.promptExperiment.findUnique({
    where: { id: experimentId },
    include: { championVersion: true, challengerVersion: true },
  });
  if (!experiment || !evaluation.winner) return experiment;

  const status = evaluation.winner === "challenger" ? "CONCLUDED_CHALLENGER" : "CONCLUDED_CHAMPION";

  await prisma.promptExperiment.update({
    where: { id: experimentId },
    data: { status, concludedAt: new Date(), metrics: evaluation as unknown as object },
  });

  if (evaluation.winner === "challenger" && experiment.autoPromote) {
    await prisma.promptProfile.update({
      where: { key: experiment.profileKey },
      data: { activeVersion: experiment.challengerVersion.version },
    });
    await prisma.promptDecision.create({
      data: {
        conversationId: experiment.championVersion.profileId, // sentinel, mirrors admin activate route
        profileKey: experiment.profileKey,
        version: experiment.challengerVersion.version,
        variant: "base",
        resolvedPrompt: experiment.challengerVersion.basePrompt,
        model: "__prompt_lab_auto_promote__",
      },
    }).catch(() => {/* non-fatal — conversationId FK may reject; that's acceptable for an audit row */});
  }

  return prisma.promptExperiment.findUnique({ where: { id: experimentId } });
}
