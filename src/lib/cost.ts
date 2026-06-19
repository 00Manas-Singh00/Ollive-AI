// Static cost table: provider+model → USD per 1k tokens (input / output)
export type CostEntry = { inputPer1k: number; outputPer1k: number };

const COST_TABLE: Record<string, Record<string, CostEntry>> = {
  gemini: {
    "gemini-2.0-flash":       { inputPer1k: 0.00010, outputPer1k: 0.00040 },
    "gemini-1.5-pro":         { inputPer1k: 0.00125, outputPer1k: 0.00500 },
    "gemini-1.5-flash":       { inputPer1k: 0.000075, outputPer1k: 0.000300 },
    default:                  { inputPer1k: 0.00010, outputPer1k: 0.00040 },
  },
  grok: {
    "grok-3-fast-beta":       { inputPer1k: 0.00050, outputPer1k: 0.00150 },
    "grok-3-beta":            { inputPer1k: 0.00300, outputPer1k: 0.01500 },
    default:                  { inputPer1k: 0.00050, outputPer1k: 0.00150 },
  },
  openai: {
    "gpt-4o":                 { inputPer1k: 0.00250, outputPer1k: 0.01000 },
    "gpt-4o-mini":            { inputPer1k: 0.000150, outputPer1k: 0.000600 },
    "gpt-4-turbo":            { inputPer1k: 0.01000, outputPer1k: 0.03000 },
    default:                  { inputPer1k: 0.00250, outputPer1k: 0.01000 },
  },
  anthropic: {
    "claude-opus-4-8":        { inputPer1k: 0.01500, outputPer1k: 0.07500 },
    "claude-sonnet-4-6":      { inputPer1k: 0.00300, outputPer1k: 0.01500 },
    "claude-haiku-4-5":       { inputPer1k: 0.000800, outputPer1k: 0.004000 },
    default:                  { inputPer1k: 0.00300, outputPer1k: 0.01500 },
  },
};

export function getCostEntry(provider: string, model: string): CostEntry {
  const providerTable = COST_TABLE[provider.toLowerCase()];
  if (!providerTable) return { inputPer1k: 0, outputPer1k: 0 };
  return providerTable[model] ?? providerTable.default ?? { inputPer1k: 0, outputPer1k: 0 };
}

export function calculateCostUsd(
  provider: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
): number {
  const entry = getCostEntry(provider, model);
  return (promptTokens / 1000) * entry.inputPer1k + (completionTokens / 1000) * entry.outputPer1k;
}
