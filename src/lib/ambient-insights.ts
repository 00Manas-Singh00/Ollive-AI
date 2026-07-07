import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { callLLMWithLogging } from "@/lib/llm";

// Confidence below which a detected pattern is not worth surfacing to the user.
const INSIGHT_CONFIDENCE_THRESHOLD = Math.min(
  1,
  Math.max(0, Number(process.env.AMBIENT_INSIGHT_CONFIDENCE ?? 0.7) || 0.7),
);

// How far back (hours) to scan a user's activity, and how many conversations to sample.
const LOOKBACK_HOURS = Math.max(1, Number(process.env.AMBIENT_INSIGHT_LOOKBACK_HOURS ?? 168) || 168);
const MAX_CONVERSATIONS = Math.max(2, Number(process.env.AMBIENT_INSIGHT_MAX_CONVERSATIONS ?? 12) || 12);

const insightSchema = z.object({
  confidence: z.number().min(0).max(1),
  triggerReason: z.string().min(1).max(500),
  suggestedMessage: z.string().min(1).max(1000),
  relatedConversationIds: z.array(z.string()).default([]),
});

const SYSTEM_PROMPT = `You are an ambient-insight engine for a chat assistant. You are given a JSON summary of a user's recent conversations. Detect a single recurring theme, unfinished thread, or opportunity where a proactive suggestion would genuinely help the user. Respond with ONLY a JSON object (no prose, no code fences) of the form:
{"confidence": <0..1>, "triggerReason": "<short reason a pattern was detected>", "suggestedMessage": "<a friendly, concrete suggestion phrased as a message to the user>", "relatedConversationIds": ["<id>", ...]}
Use confidence to express how strong and actionable the pattern is. Only reference conversation ids that appear in the input. If there is no meaningful pattern, return confidence 0.`;

type ConversationSummary = {
  id: string;
  title: string;
  recentMessages: { role: string; content: string }[];
};

/** Returns ids of users with any conversation activity inside the lookback window. */
export async function findActiveUserIds(): Promise<string[]> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const rows = await prisma.conversation.findMany({
    where: { updatedAt: { gte: since }, isArchived: false },
    select: { userId: true },
    distinct: ["userId"],
  });
  return rows.map((r) => r.userId);
}

async function collectUserActivity(userId: string): Promise<ConversationSummary[]> {
  const since = new Date(Date.now() - LOOKBACK_HOURS * 60 * 60 * 1000);
  const conversations = await prisma.conversation.findMany({
    where: { userId, isArchived: false, updatedAt: { gte: since } },
    orderBy: { updatedAt: "desc" },
    take: MAX_CONVERSATIONS,
    select: {
      id: true,
      title: true,
      messages: { orderBy: { createdAt: "desc" }, take: 6, select: { role: true, content: true } },
    },
  });

  return conversations.map((c) => ({
    id: c.id,
    title: c.title,
    // Re-order to chronological and trim content so the prompt stays bounded.
    recentMessages: c.messages
      .slice()
      .reverse()
      .map((m) => ({ role: m.role, content: m.content.slice(0, 400) })),
  }));
}

/**
 * Scans a single user's recent activity, asks the LLM to detect a recurring pattern,
 * and persists a PENDING ProactiveInsight when confidence clears the threshold.
 * Returns the created insight id, or null when nothing was surfaced.
 */
export async function generateInsightForUser(userId: string): Promise<string | null> {
  const activity = await collectUserActivity(userId);
  // Need at least two conversations to talk about a cross-conversation pattern.
  if (activity.length < 2) return null;

  // Avoid piling up unread insights for a user who hasn't looked at the last one.
  const pendingCount = await prisma.proactiveInsight.count({ where: { userId, status: "PENDING" } });
  if (pendingCount > 0) return null;

  const conversationIds = new Set(activity.map((a) => a.id));

  const result = await callLLMWithLogging({
    conversationId: activity[0].id,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: JSON.stringify({ conversations: activity }) },
    ],
  });

  const parsed = parseInsight(result.output);
  if (!parsed) return null;
  if (parsed.confidence < INSIGHT_CONFIDENCE_THRESHOLD) return null;

  const relatedConversationIds = parsed.relatedConversationIds.filter((id) => conversationIds.has(id));

  const insight = await prisma.proactiveInsight.create({
    data: {
      userId,
      triggerReason: parsed.triggerReason,
      suggestedMessage: parsed.suggestedMessage,
      relatedConversationIds,
      status: "PENDING",
    },
    select: { id: true },
  });

  return insight.id;
}

function parseInsight(raw: string): z.infer<typeof insightSchema> | null {
  // The model may wrap JSON in ```json fences or add stray prose; extract the object.
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  let json: unknown;
  try {
    json = JSON.parse(match[0]);
  } catch {
    return null;
  }
  const parsed = insightSchema.safeParse(json);
  return parsed.success ? parsed.data : null;
}
