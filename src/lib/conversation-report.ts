import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { callLLMWithLogging, preview } from "@/lib/llm";
import { moderateOutput, refusalTemplate } from "@/lib/safety";
import { assertConversationAccess } from "@/lib/collab";

const ReportSchema = z.object({
  summary: z.string(),
  topics: z.array(z.string()),
  sentimentArc: z.array(
    z.object({ turn: z.number(), sentiment: z.enum(["positive", "neutral", "negative"]) }),
  ),
  actionItems: z.array(z.string()),
  unresolvedQuestions: z.array(z.string()),
});

export type ReportData = z.infer<typeof ReportSchema>;

// Transcript budget above which we chunk-and-summarize before the final JSON pass,
// so long conversations don't blow the model's context window.
const MAX_TRANSCRIPT_CHARS = 12000;
const REPORT_TIMEOUT_MS = 30000;

const REPORT_SYSTEM_PROMPT = `You are analyzing a chat conversation transcript. Return ONLY valid JSON (no markdown fences, no commentary) matching exactly this shape:
{
  "summary": string,
  "topics": string[],
  "sentimentArc": [{ "turn": number, "sentiment": "positive" | "neutral" | "negative" }],
  "actionItems": string[],
  "unresolvedQuestions": string[]
}`;

function messagesToText(messages: Array<{ role: string; content: string }>): string {
  return messages.map((m, i) => `[${i + 1}] ${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
}

async function buildTranscript(
  conversationId: string,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const full = messagesToText(messages);
  if (full.length <= MAX_TRANSCRIPT_CHARS) return full;

  const chunks: Array<typeof messages> = [];
  let current: typeof messages = [];
  let currentLen = 0;
  for (const m of messages) {
    const lineLen = m.role.length + m.content.length;
    if (currentLen + lineLen > MAX_TRANSCRIPT_CHARS && current.length) {
      chunks.push(current);
      current = [];
      currentLen = 0;
    }
    current.push(m);
    currentLen += lineLen;
  }
  if (current.length) chunks.push(current);

  const summaries: string[] = [];
  for (const chunk of chunks) {
    const { output } = await callLLMWithLogging({
      conversationId,
      messages: [
        {
          role: "system",
          content: "Summarize this excerpt of a conversation in 3-5 sentences, preserving key topics, decisions, and open questions.",
        },
        { role: "user", content: messagesToText(chunk) },
      ],
    });
    summaries.push(output);
  }
  return summaries.map((s, i) => `Segment ${i + 1} summary:\n${s}`).join("\n\n");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : text).trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return {};
  }
}

async function generateJsonReport(
  conversationId: string,
  transcript: string,
  repairContext?: string,
): Promise<{ report: ReportData; model: string }> {
  const userContent = repairContext
    ? `${transcript}\n\nYour previous output failed validation: ${repairContext}\nReturn corrected JSON only.`
    : transcript;

  const { output, model } = await callLLMWithLogging({
    conversationId,
    messages: [
      { role: "system", content: REPORT_SYSTEM_PROMPT },
      { role: "user", content: userContent },
    ],
  });

  const parsed = ReportSchema.safeParse(extractJson(output));
  if (parsed.success) return { report: parsed.data, model };
  if (repairContext) throw new Error("Report generation failed JSON validation twice");
  return generateJsonReport(conversationId, transcript, JSON.stringify(parsed.error.issues).slice(0, 500));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error("Report generation timed out")), ms)),
  ]);
}

export async function generateReport(
  conversationId: string,
  userId: string,
): Promise<{ report: ReportData; model: string; generatedAt: Date; cached: boolean }> {
  await assertConversationAccess({ id: userId }, conversationId, "COLLABORATOR");
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });
  if (!conversation) throw new Error("NOT_FOUND");
  if (conversation.messages.length === 0) throw new Error("EMPTY_CONVERSATION");

  const existing = await prisma.conversationReport.findUnique({ where: { conversationId } });
  if (existing && existing.messageCountAtGeneration === conversation.messages.length) {
    return { report: existing.report as ReportData, model: existing.model, generatedAt: existing.generatedAt, cached: true };
  }

  const transcript = await buildTranscript(conversationId, conversation.messages);
  const { report, model } = await withTimeout(generateJsonReport(conversationId, transcript), REPORT_TIMEOUT_MS);

  const moderation = moderateOutput(report.summary);
  const finalReport: ReportData = moderation.blocked ? { ...report, summary: refusalTemplate(moderation.reason) } : report;
  await prisma.safetyAuditLog.create({
    data: {
      conversationId,
      phase: "output",
      action: moderation.blocked ? "blocked" : "allowed",
      reason: moderation.reason,
      categories: moderation.categories,
      sample: preview(report.summary),
    },
  });

  const saved = await prisma.conversationReport.upsert({
    where: { conversationId },
    create: { conversationId, report: finalReport, model, messageCountAtGeneration: conversation.messages.length },
    update: { report: finalReport, model, messageCountAtGeneration: conversation.messages.length, generatedAt: new Date() },
  });

  return { report: saved.report as ReportData, model: saved.model, generatedAt: saved.generatedAt, cached: false };
}
