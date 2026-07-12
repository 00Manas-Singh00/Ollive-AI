import { createHash } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { retrieveRelevantChunks } from "@/lib/rag";
import { getRunningExperiment, pickArmForRequest } from "@/lib/prompt-lab";

type ModelOverrides = Record<string, string>;

function stablePercent(seed: string): number {
  const hex = createHash("sha256").update(seed).digest("hex").slice(0, 8);
  const num = Number.parseInt(hex, 16);
  return num % 100;
}

export async function ensureDefaultPromptProfile() {
  const key = process.env.PROMPT_PROFILE_KEY || "chat-default";
  let profile = await prisma.promptProfile.findUnique({ where: { key }, include: { versions: true } });

  if (!profile) {
    profile = await prisma.promptProfile.create({
      data: {
        key,
        description: "Default chat prompt profile",
        activeVersion: 1,
        versions: {
          create: {
            version: 1,
            basePrompt: "You are a concise, helpful assistant. Avoid repeating the same responses in a conversation. Prefer fresh, original responses.",
            variantA: "You are concise and helpful. Keep responses practical and structured.",
            variantB: "You are concise, warm, and actionable. Prefer bullet points for clarity.",
            abRatioA: 50,
            modelOverrides: {},
            isRollbackPoint: true,
          },
        },
      },
      include: { versions: true },
    });
  }

  return profile;
}

export async function resolveSystemPrompt(params: { conversationId: string; userId?: string; model?: string; versionOverride?: number; ragQuery?: string; profileKey?: string }) {
  const profile = params.profileKey
    ? (await prisma.promptProfile.findUnique({ where: { key: params.profileKey } })) ?? (await ensureDefaultPromptProfile())
    : await ensureDefaultPromptProfile();

  let activeVersion = params.versionOverride ?? profile.activeVersion ?? 1;
  let experimentRunning = false;

  // A running A/B experiment overrides the profile's active version for a deterministic
  // slice of traffic, unless the caller explicitly pinned a version (e.g. Prompt Studio's
  // test panel or a replay override).
  if (!params.versionOverride) {
    const experiment = await getRunningExperiment(profile.key);
    if (experiment) {
      experimentRunning = true;
      const arm = pickArmForRequest(experiment.id, params.userId ?? params.conversationId, experiment.trafficSplit);
      activeVersion = arm === "challenger" ? experiment.challengerVersion.version : experiment.championVersion.version;
    }
  }

  const version = await prisma.promptVersion.findFirst({ where: { profileId: profile.id, version: activeVersion } });
  if (!version) throw new Error(`Prompt version ${activeVersion} not found for profile ${profile.key}`);

  const overrides = (version.modelOverrides || {}) as ModelOverrides;
  const modelKey = (params.model || "").toLowerCase();
  const override = modelKey ? overrides[modelKey] : undefined;

  let variant: "base" | "A" | "B" = "base";
  let resolvedPrompt = override || version.basePrompt;

  if (!override && version.variantA && version.variantB) {
    const pct = stablePercent(`${params.conversationId}:${profile.key}:${version.version}`);
    variant = pct < version.abRatioA ? "A" : "B";
    resolvedPrompt = variant === "A" ? version.variantA : version.variantB;
  }

  const ragChunks = await retrieveRelevantChunks(params.ragQuery ?? "", params.conversationId, 3).catch(() => []);
  if (ragChunks.length > 0) {
    resolvedPrompt += `\n\n## Context\n${ragChunks.map((c) => c.text).join("\n\n---\n\n")}`;
  }

  // PromptDecision is only useful for reconstructing which arm a request landed in — that's
  // only ambiguous (and only worth a row) when an experiment is actually bucketing traffic,
  // or when the caller pinned a specific version. Every other request resolves deterministically
  // from profile.activeVersion, so a row would just be write-amplification with no signal.
  if (experimentRunning || params.versionOverride) {
    await prisma.promptDecision.create({
      data: {
        conversationId: params.conversationId,
        profileKey: profile.key,
        version: version.version,
        variant,
        model: params.versionOverride ? `${params.model ?? ""}|override:v${params.versionOverride}` : params.model,
        resolvedPrompt,
      },
    });
  }

  return { profileKey: profile.key, version: version.version, variant, prompt: resolvedPrompt, ragChunks };
}
