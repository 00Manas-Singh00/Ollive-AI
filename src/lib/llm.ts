import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { LogEvent } from "@/lib/types";
import { REASONING_SUFFIX, createThoughtSplitter, extractReasoningSteps } from "@/lib/reasoning-trace";

type LLMMessage = { role: string; content: string };
export type ProviderName = "gemini" | "grok" | "openai" | "anthropic" | "ollama";
export const PROVIDER_NAMES: ProviderName[] = ["gemini", "grok", "openai", "anthropic", "ollama"];
type RoutingPolicy = "manual" | "cost" | "latency" | "quality";

export type ProviderResponse = {
  output: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  ttftMs?: number;
  streamDurationMs?: number;
};

// Max tokens the model may emit per response. The previous hardcoded 900 truncated
// long answers mid-sentence — especially on Gemini 2.5 "thinking" models, where the
// hidden reasoning phase also draws from this budget. Configurable, clamped [256, 8192].
const MAX_OUTPUT_TOKENS = Math.min(8192, Math.max(256, Number(process.env.LLM_MAX_OUTPUT_TOKENS ?? 2048) || 2048));

// Gemini 2.5 models think before answering; those thinking tokens count against the
// output budget and arrive as one post-thinking burst (no incremental streaming).
// Default 0 disables thinking so the budget goes to the visible answer and tokens
// stream as they are generated. Set GEMINI_THINKING_BUDGET to a positive value to re-enable.
const GEMINI_THINKING_BUDGET = Math.max(0, Number(process.env.GEMINI_THINKING_BUDGET ?? 0) || 0);

const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function openaiClient(baseURL?: string): OpenAI {
  return new OpenAI({
    apiKey: baseURL ? "ollama" : (process.env.OPENAI_API_KEY ?? ""),
    ...(baseURL ? { baseURL } : {}),
  });
}

function anthropicClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
}

export function preview(text: string, max = 280): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

export async function sendLog(event: LogEvent): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL;
  if (!baseUrl) return;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    await fetch(`${baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      cache: "no-store",
      signal: controller.signal,
    });
  } catch {}
  finally {
    clearTimeout(timer);
  }
}

export function providerModel(provider: ProviderName): string {
  if (provider === "grok") return process.env.GROK_MODEL || "grok-3-mini";
  if (provider === "openai") return process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (provider === "anthropic") return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  if (provider === "ollama") return process.env.OLLAMA_MODEL || "llama3";
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

export function configuredProviders(): ProviderName[] {
  const list: ProviderName[] = [];
  if (process.env.GEMINI_API_KEY) list.push("gemini");
  if (process.env.GROK_API_KEY) list.push("grok");
  if (process.env.OPENAI_API_KEY) list.push("openai");
  if (process.env.ANTHROPIC_API_KEY) list.push("anthropic");
  if (process.env.OLLAMA_BASE_URL) list.push("ollama");
  return list;
}

function providerOrder(policy: RoutingPolicy): ProviderName[] {
  const manual = (process.env.LLM_PROVIDER || "gemini").toLowerCase() as ProviderName;
  const all: ProviderName[] = ["gemini", "grok", "openai", "anthropic", "ollama"];
  if (policy === "quality") return ["anthropic", "openai", "grok", "gemini", "ollama"];
  if (policy === "latency") return ["gemini", "ollama", "openai", "grok", "anthropic"];
  if (policy === "cost") return ["ollama", "gemini", "grok", "openai", "anthropic"];
  return [manual, ...all.filter((p) => p !== manual)];
}

function getProviderPlan(providerOverride?: ProviderName): ProviderName[] {
  const configured = new Set(configuredProviders());
  if (providerOverride) {
    if (!configured.has(providerOverride)) throw new Error(`Provider ${providerOverride} is not configured`);
    return [providerOverride];
  }
  const policy = ((process.env.LLM_ROUTING_POLICY || "manual").toLowerCase() as RoutingPolicy);
  const order = providerOrder(policy).filter((p) => configured.has(p));
  if (order.length === 0) {
    throw new Error("No configured provider found. Set GEMINI_API_KEY and/or GROK_API_KEY.");
  }
  return order;
}

function isRetryableProviderError(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes("429") ||
    message.includes("rate limit") ||
    message.includes("quota") ||
    message.includes("500") ||
    message.includes("502") ||
    message.includes("503") ||
    message.includes("504") ||
    message.includes("temporar") ||
    message.includes("timed out") ||
    message.includes("network") ||
    message.includes("econn")
  );
}

async function executeWithFailover(params: {
  mode: "sync" | "stream";
  conversationId: string;
  messages: LLMMessage[];
  onToken?: (token: string) => void;
  onThought?: (thought: string) => void;
  isAborted?: () => boolean;
  providerOverride?: ProviderName;
}): Promise<{ provider: ProviderName; model: string; response: ProviderResponse }> {
  const plan = getProviderPlan(params.providerOverride);
  let lastError: unknown;

  for (let i = 0; i < plan.length; i += 1) {
    const provider = plan[i];
    const model = providerModel(provider);
    try {
      const response = await runProvider({ provider, model, ...params });
      return { provider, model, response };
    } catch (error) {
      lastError = error;
      const canFailover = i < plan.length - 1 && isRetryableProviderError(error);
      if (!canFailover) throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("All providers failed");
}

// Appends the reasoning-priming suffix to the system message so marker-based providers
// emit parseable `Thought:` lines. Anthropic uses native thinking and is never primed.
function withReasoningSuffix(messages: LLMMessage[]): LLMMessage[] {
  const idx = messages.findIndex((m) => m.role === "system");
  if (idx === -1) return [{ role: "system", content: REASONING_SUFFIX }, ...messages];
  return messages.map((m, i) => (i === idx ? { ...m, content: `${m.content}\n\n${REASONING_SUFFIX}` } : m));
}

export async function runProvider(params: {
  provider: ProviderName;
  model: string;
  mode: "sync" | "stream";
  messages: LLMMessage[];
  onToken?: (token: string) => void;
  onThought?: (thought: string) => void;
  isAborted?: () => boolean;
}): Promise<ProviderResponse> {
  const { provider, model, mode, onToken, onThought, isAborted } = params;

  // Reasoning capture is opt-in (streaming chat path only); direct callers (race, evals) are untouched.
  const reasoning = mode === "stream" && Boolean(onThought);
  const messages = reasoning && provider !== "anthropic" ? withReasoningSuffix(params.messages) : params.messages;

  if (provider === "grok") {
    const resp = await callGrok({ model, messages });
    if (mode === "stream" && !isAborted?.()) {
      if (reasoning) {
        const { steps, answer } = extractReasoningSteps(provider, resp.output);
        for (const step of steps) onThought!(step.text);
        onToken?.(answer);
        return { ...resp, output: answer };
      }
      onToken?.(resp.output);
    }
    return resp;
  }

  if (provider === "openai") {
    if (mode === "stream") return streamWithThoughtSplitter(streamOpenAI, { model, messages, onToken, onThought, isAborted });
    return callOpenAI({ model, messages });
  }

  if (provider === "anthropic") {
    if (mode === "stream") return streamAnthropic({ model, messages, onToken: onToken || (() => {}), onThought, isAborted });
    return callAnthropic({ model, messages });
  }

  if (provider === "ollama") {
    const resp = await callOllama({ model, messages });
    if (mode === "stream" && !isAborted?.()) {
      if (reasoning) {
        const { steps, answer } = extractReasoningSteps(provider, resp.output);
        for (const step of steps) onThought!(step.text);
        onToken?.(answer);
        return { ...resp, output: answer };
      }
      onToken?.(resp.output);
    }
    return resp;
  }

  if (mode === "stream") {
    return streamWithThoughtSplitter(streamGemini, { model, messages, onToken, onThought, isAborted });
  }

  return callGemini({ model, messages });
}

// Wraps a token-streaming provider so leading Thought:/Step: lines are diverted to onThought
// instead of the visible token stream. No-op passthrough when reasoning capture is off.
async function streamWithThoughtSplitter(
  streamFn: (p: { model: string; messages: LLMMessage[]; onToken: (token: string) => void; isAborted?: () => boolean }) => Promise<ProviderResponse>,
  params: {
    model: string;
    messages: LLMMessage[];
    onToken?: (token: string) => void;
    onThought?: (thought: string) => void;
    isAborted?: () => boolean;
  },
): Promise<ProviderResponse> {
  const onToken = params.onToken || (() => {});
  if (!params.onThought) {
    return streamFn({ model: params.model, messages: params.messages, onToken, isAborted: params.isAborted });
  }
  const splitter = createThoughtSplitter(onToken, params.onThought);
  const resp = await streamFn({
    model: params.model,
    messages: params.messages,
    onToken: splitter.push,
    isAborted: params.isAborted,
  });
  splitter.flush();
  return resp;
}

export async function callLLMWithLogging(params: {
  conversationId: string;
  messages: LLMMessage[];
  providerOverride?: ProviderName;
}): Promise<{ output: string; provider: ProviderName; model: string }> {
  const requestTs = new Date();
  const start = Date.now();

  try {
    const result = await executeWithFailover({
      mode: "sync",
      conversationId: params.conversationId,
      messages: params.messages,
      providerOverride: params.providerOverride,
    });
    const responseTs = new Date();

    void sendLog({
      conversationId: params.conversationId,
      provider: result.provider,
      model: result.model,
      status: "success",
      mode: "sync",
      latencyMs: Date.now() - start,
      promptTokens: result.response.promptTokens,
      completionTokens: result.response.completionTokens,
      totalTokens: result.response.totalTokens,
      requestTs: requestTs.toISOString(),
      responseTs: responseTs.toISOString(),
      inputPreview: preview(params.messages.map((m) => `${m.role}: ${m.content}`).join("\n")),
      outputPreview: preview(result.response.output),
    });

    return { output: result.response.output, provider: result.provider, model: result.model };
  } catch (error) {
    const responseTs = new Date();
    void sendLog({
      conversationId: params.conversationId,
      provider: "gemini",
      model: providerModel("gemini"),
      status: "error",
      mode: "sync",
      latencyMs: Date.now() - start,
      requestTs: requestTs.toISOString(),
      responseTs: responseTs.toISOString(),
      inputPreview: preview(JSON.stringify(params.messages)),
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}

export async function streamLLMWithLogging(params: {
  conversationId: string;
  messages: LLMMessage[];
  onToken: (token: string) => void;
  onThought?: (thought: string) => void;
  isAborted?: () => boolean;
}): Promise<{ output: string; provider: ProviderName; model: string }> {
  const requestTs = new Date();
  const start = Date.now();

  try {
    const result = await executeWithFailover({
      mode: "stream",
      conversationId: params.conversationId,
      messages: params.messages,
      onToken: params.onToken,
      onThought: params.onThought,
      isAborted: params.isAborted,
    });

    const responseTs = new Date();
    void sendLog({
      conversationId: params.conversationId,
      provider: result.provider,
      model: result.model,
      status: params.isAborted?.() ? "error" : "success",
      mode: "stream",
      latencyMs: Date.now() - start,
      ttftMs: result.response.ttftMs,
      streamDurationMs: result.response.streamDurationMs ?? Date.now() - start,
      promptTokens: result.response.promptTokens,
      completionTokens: result.response.completionTokens,
      totalTokens: result.response.totalTokens,
      requestTs: requestTs.toISOString(),
      responseTs: responseTs.toISOString(),
      inputPreview: preview(params.messages.map((m) => `${m.role}: ${m.content}`).join("\n")),
      outputPreview: preview(result.response.output),
      errorMessage: params.isAborted?.() ? "stream_aborted_by_user" : undefined,
    });

    return { output: result.response.output, provider: result.provider, model: result.model };
  } catch (error) {
    const responseTs = new Date();
    void sendLog({
      conversationId: params.conversationId,
      provider: "gemini",
      model: providerModel("gemini"),
      status: "error",
      mode: "stream",
      latencyMs: Date.now() - start,
      requestTs: requestTs.toISOString(),
      responseTs: responseTs.toISOString(),
      inputPreview: preview(JSON.stringify(params.messages)),
      errorMessage: error instanceof Error ? error.message : "Unknown error",
    });
    throw error;
  }
}

function toGeminiContents(messages: LLMMessage[]) {
  // Gemini roles: 'user' | 'model'. System messages are prepended to the first user turn.
  const systemParts: string[] = [];
  const contents: Array<{ role: "user" | "model"; parts: Array<{ text: string }> }> = [];

  for (const m of messages) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    const role = m.role === "assistant" ? "model" : "user";
    if (systemParts.length && contents.length === 0 && role === "user") {
      contents.push({ role: "user", parts: [{ text: `${systemParts.join("\n\n")}\n\n${m.content}` }] });
      systemParts.length = 0;
    } else {
      contents.push({ role, parts: [{ text: m.content }] });
    }
  }

  // Flush any remaining system content as a standalone user turn (edge case: no user message yet)
  if (systemParts.length) {
    contents.push({ role: "user", parts: [{ text: systemParts.join("\n\n") }] });
  }

  return contents;
}

async function callGemini(params: { model: string; messages: LLMMessage[] }) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const response = await geminiClient.models.generateContent({
    model: params.model,
    contents: toGeminiContents(params.messages),
    config: { temperature: 0.9, maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } },
  });

  return {
    output: response.text || "",
    promptTokens: response.usageMetadata?.promptTokenCount,
    completionTokens: response.usageMetadata?.candidatesTokenCount,
    totalTokens: response.usageMetadata?.totalTokenCount,
  };
}

async function streamGemini(params: {
  model: string;
  messages: LLMMessage[];
  onToken: (token: string) => void;
  isAborted?: () => boolean;
}) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let output = "";
  let usageMetadata:
    | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
    | undefined;

  const stream = await geminiClient.models.generateContentStream({
    model: params.model,
    contents: toGeminiContents(params.messages),
    config: { temperature: 0.9, maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } },
  });

  for await (const chunk of stream) {
    if (params.isAborted?.()) break;
    usageMetadata = chunk.usageMetadata ?? usageMetadata;
    const token = chunk.text || "";
    if (!token) continue;
    if (firstTokenAt === null) firstTokenAt = Date.now();
    output += token;
    params.onToken(token);
  }

  return {
    output,
    ttftMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
    streamDurationMs: Date.now() - startedAt,
    promptTokens: usageMetadata?.promptTokenCount,
    completionTokens: usageMetadata?.candidatesTokenCount,
    totalTokens: usageMetadata?.totalTokenCount,
  };
}

async function callGrok(params: { model: string; messages: LLMMessage[] }) {
  if (!process.env.GROK_API_KEY) throw new Error("GROK_API_KEY is not configured");
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROK_API_KEY}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      temperature: 0.9,
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Grok API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  return {
    output: data?.choices?.[0]?.message?.content || "",
    promptTokens: data?.usage?.prompt_tokens,
    completionTokens: data?.usage?.completion_tokens,
    totalTokens: data?.usage?.total_tokens,
  };
}

function toOpenAIMessages(messages: LLMMessage[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return messages.map((m) => ({
    role: m.role as "system" | "user" | "assistant",
    content: m.content,
  }));
}

async function callOpenAI(params: { model: string; messages: LLMMessage[] }): Promise<ProviderResponse> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const client = openaiClient();
  const res = await client.chat.completions.create({
    model: params.model,
    messages: toOpenAIMessages(params.messages),
    temperature: 0.9,
    max_tokens: MAX_OUTPUT_TOKENS,
  });
  return {
    output: res.choices[0]?.message?.content || "",
    promptTokens: res.usage?.prompt_tokens,
    completionTokens: res.usage?.completion_tokens,
    totalTokens: res.usage?.total_tokens,
  };
}

async function streamOpenAI(params: {
  model: string;
  messages: LLMMessage[];
  onToken: (token: string) => void;
  isAborted?: () => boolean;
}): Promise<ProviderResponse> {
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const client = openaiClient();
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let output = "";
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  const stream = await client.chat.completions.create({
    model: params.model,
    messages: toOpenAIMessages(params.messages),
    temperature: 0.9,
    max_tokens: MAX_OUTPUT_TOKENS,
    stream: true,
    stream_options: { include_usage: true },
  });

  for await (const chunk of stream) {
    if (params.isAborted?.()) break;
    const token = chunk.choices[0]?.delta?.content || "";
    if (token) {
      if (firstTokenAt === null) firstTokenAt = Date.now();
      output += token;
      params.onToken(token);
    }
    if (chunk.usage) {
      promptTokens = chunk.usage.prompt_tokens;
      completionTokens = chunk.usage.completion_tokens;
    }
  }

  return {
    output,
    ttftMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
    streamDurationMs: Date.now() - startedAt,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens !== undefined && completionTokens !== undefined ? promptTokens + completionTokens : undefined,
  };
}

function toAnthropicMessages(messages: LLMMessage[]): { system?: string; msgs: Anthropic.MessageParam[] } {
  const systemParts: string[] = [];
  const msgs: Anthropic.MessageParam[] = [];
  for (const m of messages) {
    if (m.role === "system") { systemParts.push(m.content); continue; }
    msgs.push({ role: m.role === "assistant" ? "assistant" : "user", content: m.content });
  }
  return { system: systemParts.join("\n\n") || undefined, msgs };
}

async function callAnthropic(params: { model: string; messages: LLMMessage[] }): Promise<ProviderResponse> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");
  const client = anthropicClient();
  const { system, msgs } = toAnthropicMessages(params.messages);
  const res = await client.messages.create({
    model: params.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    ...(system ? { system } : {}),
    messages: msgs,
  });
  const output = res.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("");
  return {
    output,
    promptTokens: res.usage.input_tokens,
    completionTokens: res.usage.output_tokens,
    totalTokens: res.usage.input_tokens + res.usage.output_tokens,
  };
}

async function streamAnthropic(params: {
  model: string;
  messages: LLMMessage[];
  onToken: (token: string) => void;
  onThought?: (thought: string) => void;
  isAborted?: () => boolean;
}): Promise<ProviderResponse> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");
  const client = anthropicClient();
  const { system, msgs } = toAnthropicMessages(params.messages);
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let output = "";
  let inputTokens = 0;
  let outputTokens = 0;
  let thinkBuffer = "";

  // Every onThought call carries one complete reasoning line; native thinking deltas are
  // fragments, so buffer them per line here.
  const emitThinkingLines = (final: boolean) => {
    let newline;
    while ((newline = thinkBuffer.indexOf("\n")) !== -1) {
      const line = thinkBuffer.slice(0, newline).trim();
      thinkBuffer = thinkBuffer.slice(newline + 1);
      if (line) params.onThought?.(line);
    }
    if (final && thinkBuffer.trim()) {
      params.onThought?.(thinkBuffer.trim());
      thinkBuffer = "";
    }
  };

  const stream = await client.messages.create({
    model: params.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    ...(system ? { system } : {}),
    // Native reasoning: adaptive thinking with summarized display, only when the caller
    // captures thoughts. Thinking tokens draw from max_tokens, same as Gemini's budget.
    ...(params.onThought ? { thinking: { type: "adaptive" as const, display: "summarized" as const } } : {}),
    messages: msgs,
    stream: true,
  });

  for await (const event of stream) {
    if (params.isAborted?.()) break;
    if (event.type === "content_block_delta" && event.delta.type === "thinking_delta") {
      thinkBuffer += event.delta.thinking || "";
      emitThinkingLines(false);
    }
    if (event.type === "content_block_stop") emitThinkingLines(true);
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      const token = event.delta.text;
      if (token) {
        if (firstTokenAt === null) firstTokenAt = Date.now();
        output += token;
        params.onToken(token);
      }
    }
    if (event.type === "message_delta" && event.usage) {
      outputTokens = event.usage.output_tokens;
    }
    if (event.type === "message_start" && event.message.usage) {
      inputTokens = event.message.usage.input_tokens;
    }
  }

  return {
    output,
    ttftMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
    streamDurationMs: Date.now() - startedAt,
    promptTokens: inputTokens,
    completionTokens: outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

async function callOllama(params: { model: string; messages: LLMMessage[] }): Promise<ProviderResponse> {
  const baseURL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  const client = openaiClient(baseURL);
  const res = await client.chat.completions.create({
    model: params.model,
    messages: toOpenAIMessages(params.messages),
    temperature: 0.9,
    max_tokens: MAX_OUTPUT_TOKENS,
  });
  return {
    output: res.choices[0]?.message?.content || "",
    promptTokens: res.usage?.prompt_tokens,
    completionTokens: res.usage?.completion_tokens,
    totalTokens: res.usage?.total_tokens,
  };
}
