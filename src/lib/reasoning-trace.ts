import { z } from "zod";
import { prisma } from "@/lib/prisma";
import type { ProviderName } from "@/lib/llm";

// Phase 13 — Visible Reasoning Trace.
// Providers with native reasoning output (Anthropic extended/adaptive thinking) surface it
// directly; all other providers are primed via REASONING_SUFFIX to emit structured
// `Thought:` lines before the answer, which are parsed out and never shown as answer text.

export const ReasoningStepSchema = z.object({
  index: z.number().int().nonnegative(),
  text: z.string().min(1),
});
export const ReasoningStepsSchema = z.array(ReasoningStepSchema);
export type ReasoningStep = z.infer<typeof ReasoningStepSchema>;

// Appended to the system prompt for providers without native reasoning output.
export const REASONING_SUFFIX = [
  "Before answering, briefly reason step by step.",
  'Write each reasoning step on its own line starting with "Thought: " (2-5 short steps).',
  "After the last thought line, write your final answer normally. Never reference the thought lines in the answer.",
].join(" ");

const THOUGHT_MARKER = /^\s*(?:thought|step)\s*(?:\d+)?\s*[:\-]\s*/i;

function toSteps(lines: string[]): ReasoningStep[] {
  const steps = lines
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text, index) => ({ index, text }));
  return ReasoningStepsSchema.parse(steps);
}

// Splits a complete raw response into reasoning steps + the visible answer.
// Native-reasoning providers never have markers in the answer text, so this is a no-op there.
export function extractReasoningSteps(
  provider: ProviderName,
  rawResponse: string,
): { steps: ReasoningStep[]; answer: string } {
  void provider; // parsing is marker-based; provider reserved for format-specific handling
  const lines = rawResponse.split("\n");
  const thoughts: string[] = [];
  let answerStart = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.trim()) {
      answerStart = i + 1;
      continue;
    }
    if (THOUGHT_MARKER.test(line)) {
      thoughts.push(line.replace(THOUGHT_MARKER, ""));
      answerStart = i + 1;
      continue;
    }
    answerStart = i;
    break;
  }

  return { steps: toSteps(thoughts), answer: lines.slice(answerStart).join("\n").trimStart() };
}

// Builds validated steps from accumulated thought text (live SSE chunks joined together).
export function buildReasoningSteps(thinkingText: string): ReasoningStep[] {
  return toSteps(thinkingText.split("\n"));
}

// Streaming variant of extractReasoningSteps: routes leading Thought:/Step: lines to
// onThought and everything after to onToken, so marker lines never reach the visible stream.
export function createThoughtSplitter(
  onToken: (token: string) => void,
  onThought: (thought: string) => void,
): { push: (token: string) => void; flush: () => void } {
  let buffer = "";
  let reasoning = true;

  const mightBeMarker = (text: string) => {
    const t = text.trimStart().toLowerCase();
    return !t || "thought".startsWith(t) || t.startsWith("thought") || "step".startsWith(t) || t.startsWith("step");
  };

  const push = (token: string) => {
    if (!reasoning) {
      onToken(token);
      return;
    }
    buffer += token;

    while (reasoning) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) {
        // Can't be a marker line anymore — stop buffering so answer tokens stream live.
        if (!mightBeMarker(buffer)) {
          reasoning = false;
          onToken(buffer);
          buffer = "";
        }
        return;
      }
      const line = buffer.slice(0, newline);
      const rest = buffer.slice(newline + 1);
      if (!line.trim()) {
        buffer = rest;
        continue;
      }
      if (THOUGHT_MARKER.test(line)) {
        onThought(line.replace(THOUGHT_MARKER, ""));
        buffer = rest;
        continue;
      }
      reasoning = false;
      buffer = "";
      onToken(`${line}\n${rest}`);
    }
  };

  const flush = () => {
    if (!buffer) return;
    if (reasoning && THOUGHT_MARKER.test(buffer)) onThought(buffer.replace(THOUGHT_MARKER, ""));
    else onToken(buffer);
    buffer = "";
  };

  return { push, flush };
}

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";

// Streaming splitter for models that natively emit a leading <think>...</think> block
// (e.g. GLM/Qwen3-style reasoning models on a self-hosted OpenAI-compatible endpoint) —
// no system-prompt priming needed. Content inside the tag is routed to onThought line by
// line; everything else passes straight through to onToken. A complete no-op passthrough
// when no <think> tag ever appears (aside from a few characters of unavoidable buffering
// while detecting the tag).
export function createThinkTagSplitter(
  onToken: (token: string) => void,
  onThought: (thought: string) => void,
): { push: (token: string) => void; flush: () => void } {
  let buffer = "";
  let state: "before" | "thinking" | "after" = "before";
  let thoughtBuffer = "";

  const emitThoughtLines = (final: boolean) => {
    let nl;
    while ((nl = thoughtBuffer.indexOf("\n")) !== -1) {
      const line = thoughtBuffer.slice(0, nl).trim();
      thoughtBuffer = thoughtBuffer.slice(nl + 1);
      if (line) onThought(line);
    }
    if (final && thoughtBuffer.trim()) {
      onThought(thoughtBuffer.trim());
      thoughtBuffer = "";
    }
  };

  const push = (token: string) => {
    buffer += token;

    if (state === "before") {
      if (buffer.length < THINK_OPEN.length) {
        if (THINK_OPEN.startsWith(buffer)) return; // could still become the tag — wait for more
        onToken(buffer);
        buffer = "";
        state = "after";
        return;
      }
      if (buffer.startsWith(THINK_OPEN)) {
        state = "thinking";
        buffer = buffer.slice(THINK_OPEN.length);
      } else {
        onToken(buffer);
        buffer = "";
        state = "after";
        return;
      }
    }

    if (state === "thinking") {
      const closeIdx = buffer.indexOf(THINK_CLOSE);
      if (closeIdx === -1) {
        const keepTail = Math.min(buffer.length, THINK_CLOSE.length - 1);
        const safe = buffer.slice(0, buffer.length - keepTail);
        if (safe) {
          thoughtBuffer += safe;
          emitThoughtLines(false);
        }
        buffer = buffer.slice(buffer.length - keepTail);
        return;
      }
      thoughtBuffer += buffer.slice(0, closeIdx);
      emitThoughtLines(true);
      buffer = buffer.slice(closeIdx + THINK_CLOSE.length);
      state = "after";
      if (buffer) {
        onToken(buffer);
        buffer = "";
      }
      return;
    }

    if (state === "after") {
      onToken(buffer);
      buffer = "";
    }
  };

  const flush = () => {
    if (state === "thinking") {
      thoughtBuffer += buffer;
      emitThoughtLines(true);
      buffer = "";
      return;
    }
    if (buffer) {
      onToken(buffer);
      buffer = "";
    }
  };

  return { push, flush };
}

// Fire-and-forget persistence, same pattern as InferenceLog dispatch — never await.
export function persistReasoningTrace(params: {
  messageId: string;
  provider: string;
  thinkingText: string;
}): void {
  try {
    const steps = buildReasoningSteps(params.thinkingText);
    if (steps.length === 0) return;
    void prisma.reasoningTrace
      .create({ data: { messageId: params.messageId, provider: params.provider, steps } })
      .catch(() => {});
  } catch {
    // Trace persistence must never fail the chat request.
  }
}
