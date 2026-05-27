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

const OUTPUT_BLOCK_PATTERNS: Array<{ category: string; re: RegExp }> = [
  { category: "dangerous-instructions", re: /\b(step-by-step|do this first|payload|bypass antivirus)\b/i },
];

export function moderateInput(text: string): ModerationResult {
  const hits = INPUT_BLOCK_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.category);
  if (hits.length) {
    return { blocked: true, reason: `blocked_input_${hits[0]}`, categories: hits };
  }
  return { blocked: false, reason: null, categories: [] };
}

export function moderateOutput(text: string): ModerationResult {
  const hits = OUTPUT_BLOCK_PATTERNS.filter((p) => p.re.test(text)).map((p) => p.category);
  if (hits.length) {
    return { blocked: true, reason: `blocked_output_${hits[0]}`, categories: hits };
  }
  return { blocked: false, reason: null, categories: [] };
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
