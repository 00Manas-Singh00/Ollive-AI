import { z } from "zod";

export type ModerationPhase = "input" | "output";

export type ModerationResult = {
  blocked: boolean;
  reason: string | null;
  categories: string[];
};

const INPUT_BLOCK_PATTERNS: Array<{ category: string; re: RegExp }> = [
  { category: "malware", re: /\b(malware|ransomware|keylogger|credential dumping|steal passwords)\b/i },
  { category: "weapons", re: /\b(build a bomb|make explosives|3d[- ]?printed gun)\b/i },
  { category: "self-harm", re: /\b(kill myself|suicide plan|self harm plan)\b/i },
];

// "step-by-step" and "do this first" were over-broad — they matched ordinary helpful
// instructions (recipes, tutorials, setup guides) with no relation to actual harm.
const OUTPUT_BLOCK_PATTERNS: Array<{ category: string; re: RegExp }> = [
  { category: "dangerous-instructions", re: /\b(payload|bypass antivirus)\b/i },
];

function moderateInputRegex(text: string): ModerationResult {
  const hits = INPUT_BLOCK_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.category);
  if (hits.length) {
    return { blocked: true, reason: `blocked_input_${hits[0]}`, categories: hits };
  }
  return { blocked: false, reason: null, categories: [] };
}

function moderateOutputRegex(text: string): ModerationResult {
  const hits = OUTPUT_BLOCK_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.category);
  if (hits.length) {
    return { blocked: true, reason: `blocked_output_${hits[0]}`, categories: hits };
  }
  return { blocked: false, reason: null, categories: [] };
}

const verdictSchema = z.object({
  blocked: z.boolean(),
  category: z.string().optional(),
  reason: z.string().optional(),
});

// Runs the configured smallModel() on the primary endpoint as a safety classifier. Returns
// null (never throws) on any failure — missing "primary" provider, network error, invalid
// JSON, schema mismatch — so callers can fail open to the regex path unconditionally.
async function llmJudge(phase: ModerationPhase, text: string): Promise<ModerationResult | null> {
  try {
    const { configuredProviders, smallModel, runProvider } = await import("@/lib/llm");
    if (!configuredProviders().includes("primary")) return null;

    const system =
      phase === "input"
        ? "You are a safety classifier for a chat assistant's INPUT (the user's message). " +
          "Decide whether the message requests genuinely harmful content (malware/hacking tools, weapons/explosives instructions, " +
          "self-harm instructions). Ordinary requests — including step-by-step tutorials, code, or instructions for benign tasks — are NOT blocked. " +
          'Respond with ONLY a JSON object: {"blocked": boolean, "category": string, "reason": string}. No prose, no markdown fences.'
        : "You are a safety classifier for a chat assistant's OUTPUT (its response to a user). " +
          "Decide whether the response contains genuinely harmful content (malware/hacking payloads, weapons/explosives instructions, " +
          "self-harm instructions, antivirus/security-control bypass instructions). Ordinary helpful instructions are NOT blocked. " +
          'Respond with ONLY a JSON object: {"blocked": boolean, "category": string, "reason": string}. No prose, no markdown fences.';

    const response = await runProvider({
      provider: "primary",
      model: smallModel(),
      mode: "sync",
      messages: [
        { role: "system", content: system },
        { role: "user", content: text.slice(0, 4000) },
      ],
    });

    const jsonText = response.output.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    const parsed = verdictSchema.parse(JSON.parse(jsonText));
    if (!parsed.blocked) return { blocked: false, reason: null, categories: [] };
    const category = parsed.category || "llm-judge";
    return { blocked: true, reason: `blocked_${phase}_${category}`, categories: [category] };
  } catch {
    return null;
  }
}

export async function moderateInput(text: string): Promise<ModerationResult> {
  if (process.env.SAFETY_JUDGE === "llm") {
    const verdict = await llmJudge("input", text);
    if (verdict) return verdict;
  }
  return moderateInputRegex(text);
}

export async function moderateOutput(text: string): Promise<ModerationResult> {
  if (process.env.SAFETY_JUDGE === "llm") {
    const verdict = await llmJudge("output", text);
    if (verdict) return verdict;
  }
  return moderateOutputRegex(text);
}

export function refusalTemplate(reason: string | null): string {
  const custom = process.env.SAFETY_REFUSAL_TEMPLATE;
  if (custom && custom.trim()) return custom;

  switch (reason) {
    case "blocked_input_malware":
      return "I can’t help with creating or improving malware or credential theft. I can help with defensive security practices instead.";
    case "blocked_input_weapons":
      return "I can’t help with weapon or explosive instructions. I can help with safety/legal information instead.";
    case "blocked_input_self-harm":
      return "I’m really sorry you’re dealing with this. I can’t help with self-harm instructions, but I can share immediate support resources if you want.";
    default:
      return "I can’t help with that request safely, but I can help with a safer alternative.";
  }
}
