import { z } from "zod";

export type QualityBreakdown = {
  lengthScore: number;
  repetitionScore: number;
  structureScore: number;
  refusalPenalty: number;
};

export type QualityResult = {
  score: number;
  breakdown: QualityBreakdown;
  reason: string;
};

const REFUSAL_PATTERNS = /\b(i can.?t help with that|i'?m unable to|as an ai language model)\b/i;

function scoreLength(content: string): number {
  const words = content.trim().split(/\s+/).filter(Boolean).length;
  if (words === 0) return 0;
  if (words < 5) return 10;
  if (words > 800) return 60;
  return Math.min(100, Math.round((words / 150) * 100));
}

function scoreRepetition(content: string): number {
  const words = content.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length < 10) return 100;
  const unique = new Set(words);
  const ratio = unique.size / words.length;
  return Math.round(ratio * 100);
}

function scoreStructure(content: string): number {
  const hasSentences = /[.!?]/.test(content);
  const hasParagraphs = content.includes("\n") || content.length > 200;
  let score = 40;
  if (hasSentences) score += 30;
  if (hasParagraphs) score += 30;
  return Math.min(100, score);
}

export function scoreResponse(content: string): QualityResult {
  const lengthScore = scoreLength(content);
  const repetitionScore = scoreRepetition(content);
  const structureScore = scoreStructure(content);
  const refusalPenalty = REFUSAL_PATTERNS.test(content) ? 40 : 0;

  const breakdown: QualityBreakdown = { lengthScore, repetitionScore, structureScore, refusalPenalty };

  const raw = (lengthScore + repetitionScore + structureScore) / 3 - refusalPenalty;
  const score = Math.max(0, Math.min(100, Math.round(raw)));

  const reason =
    refusalPenalty > 0
      ? "Response contains a refusal pattern"
      : score < 40
        ? "Low length, repetition, or structure signal"
        : "Heuristic scoring across length, repetition, and structure";

  return { score, breakdown, reason };
}

const rubricSchema = z.object({
  helpfulness: z.number().min(0).max(100),
  correctness: z.number().min(0).max(100),
  clarity: z.number().min(0).max(100),
  reason: z.string(),
});

// Rubric-scores a response with smallModel() on the primary endpoint. Returns null (never
// throws) on any failure so the caller falls back to the heuristic scorer unconditionally.
async function scoreResponseLLM(userPrompt: string, content: string): Promise<QualityResult | null> {
  try {
    const { configuredProviders, smallModel, runProvider } = await import("@/lib/llm");
    if (!configuredProviders().includes("primary")) return null;

    const system =
      "You are a quality rubric judge for an assistant's response. Score the response 0-100 on each of: " +
      "helpfulness (does it address the user's request), correctness (no obvious factual/logical errors), " +
      'and clarity (well-structured, easy to follow). Respond with ONLY a JSON object: ' +
      '{"helpfulness": number, "correctness": number, "clarity": number, "reason": string}. No prose, no markdown fences.';

    const response = await runProvider({
      provider: "primary",
      model: smallModel(),
      mode: "sync",
      messages: [
        { role: "system", content: system },
        { role: "user", content: `User request:\n${userPrompt.slice(0, 2000)}\n\nAssistant response:\n${content.slice(0, 4000)}` },
      ],
    });

    const jsonText = response.output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = rubricSchema.parse(JSON.parse(jsonText));
    const score = Math.round((parsed.helpfulness + parsed.correctness + parsed.clarity) / 3);
    return {
      score,
      breakdown: {
        lengthScore: parsed.helpfulness,
        repetitionScore: parsed.correctness,
        structureScore: parsed.clarity,
        refusalPenalty: 0,
      },
      reason: parsed.reason,
    };
  } catch {
    return null;
  }
}

// Dispatches to the LLM rubric judge when QUALITY_JUDGE=llm, falling back to the
// heuristic scorer above on any failure (including when unset — the default).
export async function scoreResponseSmart(userPrompt: string, content: string): Promise<QualityResult> {
  if (process.env.QUALITY_JUDGE === "llm") {
    const verdict = await scoreResponseLLM(userPrompt, content);
    if (verdict) return verdict;
  }
  return scoreResponse(content);
}
