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
