import { randomUUID } from "crypto";
import { GoogleGenAI } from "@google/genai";
import OpenAI from "openai";
import Anthropic from "@anthropic-ai/sdk";
import type { LogEvent } from "@/lib/types";
import { REASONING_SUFFIX, createThoughtSplitter, createThinkTagSplitter, extractReasoningSteps } from "@/lib/reasoning-trace";
import { getIngestQueue } from "@/lib/queue";
import { writeLogDirect } from "@/lib/log-sink";

type LLMMessage = { role: string; content: string };
export type ProviderName = "primary" | "gemini" | "grok" | "openai" | "anthropic" | "ollama";
export const PROVIDER_NAMES: ProviderName[] = ["primary", "gemini", "grok", "openai", "anthropic", "ollama"];
// Providers other than "primary" (self-hosted OpenAI-compatible endpoint) and "gemini"
// (backup) are legacy/manual-only and hidden from configuredProviders() unless opted in.
const EXTRA_PROVIDERS_ENABLED = process.env.ENABLE_EXTRA_PROVIDERS === "true";

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

// Ordinary chat sampling temperature — configurable, existing default (0.9) unchanged.
const CHAT_TEMPERATURE = Math.max(0, Math.min(2, Number(process.env.LLM_TEMPERATURE ?? 0.9) || 0.9));

// Tool-calling turns are deliberately low-temperature: we want reliable, well-formed
// tool_calls JSON, not creative variation.
const TOOL_LOOP_TEMPERATURE = 0.2;

// Anthropic requires budget_tokens < max_tokens; leave headroom for the visible answer.
const ANTHROPIC_THINKING_BUDGET = Math.max(
  1024,
  Math.min(MAX_OUTPUT_TOKENS - 256, Number(process.env.ANTHROPIC_THINKING_BUDGET_TOKENS ?? 4096) || 4096),
);

// Gemini 2.5 models think before answering; those thinking tokens count against the
// output budget and arrive as one post-thinking burst (no incremental streaming).
// Default 0 disables thinking so the budget goes to the visible answer and tokens
// stream as they are generated. Set GEMINI_THINKING_BUDGET to a positive value to re-enable.
const GEMINI_THINKING_BUDGET = Math.max(0, Number(process.env.GEMINI_THINKING_BUDGET ?? 0) || 0);

const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function openaiClient(baseURL?: string, apiKey?: string): OpenAI {
  return new OpenAI({
    apiKey: apiKey ?? (baseURL ? "none" : (process.env.OPENAI_API_KEY ?? "")),
    ...(baseURL ? { baseURL } : {}),
  });
}

function primaryEndpoint(): { baseURL: string; apiKey: string } {
  return { baseURL: process.env.LLM_BASE_URL || "", apiKey: process.env.LLM_API_KEY || "none" };
}

function anthropicClient(): Anthropic {
  return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
}

export function preview(text: string, max = 280): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

// Fire-and-forget by contract (never awaited by callers). Enqueues in-process onto the
// BullMQ ingest queue when Redis is configured; on any failure (or no Redis at all)
// falls back to writing the InferenceLog row directly so a log is never silently dropped.
export async function sendLog(event: LogEvent): Promise<void> {
  if (process.env.REDIS_URL) {
    try {
      await getIngestQueue().add("ingest-log", { eventId: event.eventId, payload: event }, { jobId: event.eventId });
      return;
    } catch {
      // fall through to direct write
    }
  }
  try {
    await writeLogDirect(event);
  } catch {}
}

export function providerModel(provider: ProviderName): string {
  if (provider === "primary") return process.env.LLM_CHAT_MODEL || "";
  if (provider === "grok") return process.env.GROK_MODEL || "grok-3-mini";
  if (provider === "openai") return process.env.OPENAI_MODEL || "gpt-4o-mini";
  if (provider === "anthropic") return process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6";
  if (provider === "ollama") return process.env.OLLAMA_MODEL || "llama3";
  return process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

// Cheaper/faster model for background jobs (judging, moderation, titles) served by the
// primary self-hosted endpoint. Falls back to the flagship chat model when unset.
export function smallModel(): string {
  return process.env.LLM_SMALL_MODEL || process.env.LLM_CHAT_MODEL || "";
}

export function configuredProviders(): ProviderName[] {
  const list: ProviderName[] = [];
  if (process.env.LLM_BASE_URL) list.push("primary");
  if (process.env.GEMINI_API_KEY) list.push("gemini");
  if (EXTRA_PROVIDERS_ENABLED) {
    if (process.env.GROK_API_KEY) list.push("grok");
    if (process.env.OPENAI_API_KEY) list.push("openai");
    if (process.env.ANTHROPIC_API_KEY) list.push("anthropic");
    if (process.env.OLLAMA_BASE_URL) list.push("ollama");
  }
  return list;
}

// Automatic plan is always [primary, gemini] (whichever is configured) — gemini is a pure
// backup, never a routing-policy alternative. providerOverride bypasses this entirely.
export function getProviderPlan(providerOverride?: ProviderName): ProviderName[] {
  const configured = new Set(configuredProviders());
  if (providerOverride) {
    if (!configured.has(providerOverride)) throw new Error(`Provider ${providerOverride} is not configured`);
    return [providerOverride];
  }
  const order = (["primary", "gemini"] as ProviderName[]).filter((p) => configured.has(p));
  if (order.length === 0) {
    throw new Error("No configured provider found. Set LLM_BASE_URL and/or GEMINI_API_KEY.");
  }
  return order;
}

// Typed status check only — no message substring sniffing. Covers SDK errors (OpenAI/
// Anthropic expose `.status`; fetch-based adapters attach `.status` themselves), raw
// Response-shaped errors (`.response.status`), and network-level failures (ECONNREFUSED
// etc., or a bare fetch TypeError).
function isRetryableProviderError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const status = (error as { status?: unknown }).status ?? (error as { response?: { status?: unknown } }).response?.status;
  if (typeof status === "number") return status === 429 || (status >= 500 && status < 600);
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" && ["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"].includes(code)) return true;
  if (error instanceof TypeError && /fetch/i.test(error.message)) return true;
  return false;
}

type ProviderTaggedError = Error & { llmProvider?: ProviderName; llmModel?: string };

function tagError(error: unknown, provider: ProviderName, model: string): unknown {
  if (error instanceof Error) {
    (error as ProviderTaggedError).llmProvider = provider;
    (error as ProviderTaggedError).llmModel = model;
  }
  return error;
}

// Reads the provider/model actually attempted off an error thrown by executeWithFailover,
// falling back to what the plan would have picked first (never a hardcoded provider name).
export function lastAttemptFromError(error: unknown, providerOverride?: ProviderName): { provider: ProviderName; model: string } {
  const tagged = error as ProviderTaggedError;
  if (tagged?.llmProvider) return { provider: tagged.llmProvider, model: tagged.llmModel || providerModel(tagged.llmProvider) };
  const provider = getProviderPlan(providerOverride)[0];
  return { provider, model: providerModel(provider) };
}

async function executeWithFailover(params: {
  mode: "sync" | "stream";
  conversationId: string;
  messages: LLMMessage[];
  onToken?: (token: string) => void;
  onThought?: (thought: string) => void;
  isAborted?: () => boolean;
  providerOverride?: ProviderName;
  modelOverride?: string;
}): Promise<{ provider: ProviderName; model: string; response: ProviderResponse }> {
  const plan = getProviderPlan(params.providerOverride);
  let lastError: unknown;
  let lastAttempt: { provider: ProviderName; model: string } = { provider: plan[0], model: providerModel(plan[0]) };

  for (let i = 0; i < plan.length; i += 1) {
    const provider = plan[i];
    const model = (params.providerOverride && params.modelOverride) || providerModel(provider);
    lastAttempt = { provider, model };
    let tokenEmitted = false;
    const onToken = params.onToken
      ? (token: string) => {
          tokenEmitted = true;
          params.onToken!(token);
        }
      : undefined;
    try {
      const response = await runProvider({ provider, model, ...params, onToken });
      return { provider, model, response };
    } catch (error) {
      lastError = error;
      // Never switch providers once a token has reached the client — only a clean,
      // pre-first-token failure is safe to silently retry on the backup.
      const canFailover = i < plan.length - 1 && !tokenEmitted && isRetryableProviderError(error);
      if (!canFailover) throw tagError(error, provider, model);
    }
  }

  throw tagError(lastError instanceof Error ? lastError : new Error("All providers failed"), lastAttempt.provider, lastAttempt.model);
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
  // "primary" is excluded from the Thought:-priming suffix — self-hosted reasoning models
  // (GLM/Qwen3-style) emit a native <think>...</think> block instead, parsed by
  // createThinkTagSplitter below with no prompt changes needed.
  const reasoning = mode === "stream" && Boolean(onThought);
  const messages =
    reasoning && provider !== "anthropic" && provider !== "primary" ? withReasoningSuffix(params.messages) : params.messages;

  if (provider === "primary") {
    const { baseURL, apiKey } = primaryEndpoint();
    if (mode === "stream") {
      return streamWithSplitter(
        (p) => streamOpenAI({ ...p, baseURL, apiKey }),
        createThinkTagSplitter,
        { model, messages, onToken, onThought, isAborted },
      );
    }
    return callOpenAI({ model, messages, baseURL, apiKey });
  }

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

type StreamSplitter = { push: (token: string) => void; flush: () => void };

// Wraps a token-streaming provider so reasoning content (however the splitter recognizes
// it — Thought:/Step: marker lines, or a native <think> tag) is diverted to onThought
// instead of the visible token stream. No-op passthrough when reasoning capture is off.
async function streamWithSplitter(
  streamFn: (p: { model: string; messages: LLMMessage[]; onToken: (token: string) => void; isAborted?: () => boolean }) => Promise<ProviderResponse>,
  makeSplitter: (onToken: (token: string) => void, onThought: (thought: string) => void) => StreamSplitter,
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
  const splitter = makeSplitter(onToken, params.onThought);
  const resp = await streamFn({
    model: params.model,
    messages: params.messages,
    onToken: splitter.push,
    isAborted: params.isAborted,
  });
  splitter.flush();
  return resp;
}

// Marker-based (Thought:/Step: lines) — used by legacy providers primed with REASONING_SUFFIX.
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
  return streamWithSplitter(streamFn, createThoughtSplitter, params);
}

export async function callLLMWithLogging(params: {
  conversationId: string;
  messages: LLMMessage[];
  providerOverride?: ProviderName;
  modelOverride?: string;
}): Promise<{ output: string; provider: ProviderName; model: string }> {
  const requestTs = new Date();
  const start = Date.now();
  const eventId = randomUUID();

  try {
    const result = await executeWithFailover({
      mode: "sync",
      conversationId: params.conversationId,
      messages: params.messages,
      providerOverride: params.providerOverride,
      modelOverride: params.modelOverride,
    });
    const responseTs = new Date();

    void sendLog({
      eventId,
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
    const { provider, model } = lastAttemptFromError(error, params.providerOverride);
    void sendLog({
      eventId,
      conversationId: params.conversationId,
      provider,
      model,
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
  providerOverride?: ProviderName;
  modelOverride?: string;
}): Promise<{ output: string; provider: ProviderName; model: string }> {
  const requestTs = new Date();
  const start = Date.now();
  const eventId = randomUUID();

  try {
    const result = await executeWithFailover({
      mode: "stream",
      conversationId: params.conversationId,
      messages: params.messages,
      onToken: params.onToken,
      onThought: params.onThought,
      isAborted: params.isAborted,
      providerOverride: params.providerOverride,
      modelOverride: params.modelOverride,
    });

    const responseTs = new Date();
    void sendLog({
      eventId,
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
    const { provider, model } = lastAttemptFromError(error, params.providerOverride);
    void sendLog({
      eventId,
      conversationId: params.conversationId,
      provider,
      model,
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
    config: { temperature: CHAT_TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } },
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
    config: { temperature: CHAT_TEMPERATURE, maxOutputTokens: MAX_OUTPUT_TOKENS, thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET } },
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
      temperature: CHAT_TEMPERATURE,
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

async function callOpenAI(params: { model: string; messages: LLMMessage[]; baseURL?: string; apiKey?: string }): Promise<ProviderResponse> {
  if (!params.baseURL && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const client = openaiClient(params.baseURL, params.apiKey);
  const res = await client.chat.completions.create({
    model: params.model,
    messages: toOpenAIMessages(params.messages),
    temperature: CHAT_TEMPERATURE,
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
  baseURL?: string;
  apiKey?: string;
}): Promise<ProviderResponse> {
  if (!params.baseURL && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const client = openaiClient(params.baseURL, params.apiKey);
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let output = "";
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;

  const stream = await client.chat.completions.create({
    model: params.model,
    messages: toOpenAIMessages(params.messages),
    temperature: CHAT_TEMPERATURE,
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
    // Native reasoning, only when the caller captures thoughts. Thinking tokens draw from
    // max_tokens (budget_tokens must be strictly less than max_tokens per the Anthropic API).
    ...(params.onThought && ANTHROPIC_THINKING_BUDGET < MAX_OUTPUT_TOKENS
      ? { thinking: { type: "enabled" as const, budget_tokens: ANTHROPIC_THINKING_BUDGET } }
      : {}),
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

// --- Phase 18: Agentic Tool Use (Function Calling) ---
// A provider-agnostic single-round call used by src/lib/tools/loop.ts. Kept
// separate from runProvider (which the streaming chat path uses) so existing
// callers are untouched — tool loops are sync-mode only.

export type ToolDefinitionForProvider = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCallRequest = { id: string; name: string; arguments: unknown };
export type ToolTurn =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls?: ToolCallRequest[] }
  | { role: "tool"; toolCallId: string; name: string; content: string };

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export async function runProviderWithTools(params: {
  provider: ProviderName;
  model: string;
  turns: ToolTurn[];
  tools: ToolDefinitionForProvider[];
}): Promise<{ content: string; toolCalls: ToolCallRequest[] }> {
  if (params.provider === "primary") {
    const { baseURL, apiKey } = primaryEndpoint();
    return callOpenAIWithTools({ ...params, baseURL, apiKey });
  }
  if (params.provider === "anthropic") return callAnthropicWithTools(params);
  if (params.provider === "openai") return callOpenAIWithTools(params);
  if (params.provider === "grok") return callGrokWithTools(params);
  if (params.provider === "gemini") return callGeminiWithTools(params);
  // Ollama models rarely support function calling reliably — answer in plain text.
  const plain = await callOllama({ model: params.model, messages: turnsToPlainMessages(params.turns) });
  return { content: plain.output, toolCalls: [] };
}

function turnsToPlainMessages(turns: ToolTurn[]): LLMMessage[] {
  return turns.filter((t) => t.role !== "tool").map((t) => ({ role: t.role, content: t.content }));
}

async function callAnthropicWithTools(params: {
  model: string;
  turns: ToolTurn[];
  tools: ToolDefinitionForProvider[];
}): Promise<{ content: string; toolCalls: ToolCallRequest[] }> {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not configured");
  const client = anthropicClient();
  const systemParts: string[] = [];
  const messages: Anthropic.MessageParam[] = [];
  let toolResultAccum: Anthropic.ToolResultBlockParam[] = [];

  const flushToolAccum = () => {
    if (toolResultAccum.length) {
      messages.push({ role: "user", content: toolResultAccum });
      toolResultAccum = [];
    }
  };

  for (const t of params.turns) {
    if (t.role === "tool") {
      toolResultAccum.push({ type: "tool_result", tool_use_id: t.toolCallId, content: t.content });
      continue;
    }
    flushToolAccum();
    if (t.role === "system") { systemParts.push(t.content); continue; }
    if (t.role === "user") { messages.push({ role: "user", content: t.content }); continue; }
    const blocks: Anthropic.ContentBlockParam[] = [];
    if (t.content) blocks.push({ type: "text", text: t.content });
    for (const call of t.toolCalls ?? []) {
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input: (call.arguments ?? {}) as Record<string, unknown> });
    }
    messages.push({ role: "assistant", content: blocks });
  }
  flushToolAccum();

  const res = await client.messages.create({
    model: params.model,
    max_tokens: MAX_OUTPUT_TOKENS,
    ...(systemParts.length ? { system: systemParts.join("\n\n") } : {}),
    messages,
    ...(params.tools.length
      ? { tools: params.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })) }
      : {}),
  });

  const content = res.content.filter((b) => b.type === "text").map((b) => (b as Anthropic.TextBlock).text).join("");
  const toolCalls: ToolCallRequest[] = res.content
    .filter((b): b is Anthropic.ToolUseBlock => b.type === "tool_use")
    .map((b) => ({ id: b.id, name: b.name, arguments: b.input }));

  return { content, toolCalls };
}

function turnsToOpenAIMessages(turns: ToolTurn[]): OpenAI.Chat.ChatCompletionMessageParam[] {
  return turns.map((t): OpenAI.Chat.ChatCompletionMessageParam => {
    if (t.role === "assistant") {
      return {
        role: "assistant",
        content: t.content || null,
        ...(t.toolCalls?.length
          ? { tool_calls: t.toolCalls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } })) }
          : {}),
      };
    }
    if (t.role === "tool") {
      return { role: "tool", tool_call_id: t.toolCallId, content: t.content };
    }
    return { role: t.role, content: t.content };
  });
}

async function callOpenAIWithTools(params: {
  model: string;
  turns: ToolTurn[];
  tools: ToolDefinitionForProvider[];
  baseURL?: string;
  apiKey?: string;
}): Promise<{ content: string; toolCalls: ToolCallRequest[] }> {
  if (!params.baseURL && !process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const client = openaiClient(params.baseURL, params.apiKey);
  const res = await client.chat.completions.create({
    model: params.model,
    messages: turnsToOpenAIMessages(params.turns),
    temperature: TOOL_LOOP_TEMPERATURE,
    max_tokens: MAX_OUTPUT_TOKENS,
    ...(params.tools.length
      ? {
          tools: params.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
          tool_choice: "auto" as const,
        }
      : {}),
  });
  const msg = res.choices[0]?.message;
  const toolCalls: ToolCallRequest[] = (msg?.tool_calls ?? [])
    .filter((tc): tc is OpenAI.Chat.ChatCompletionMessageFunctionToolCall => tc.type === "function")
    .map((tc) => ({ id: tc.id, name: tc.function.name, arguments: safeJsonParse(tc.function.arguments) }));

  return { content: msg?.content || "", toolCalls };
}

async function callGrokWithTools(params: {
  model: string;
  turns: ToolTurn[];
  tools: ToolDefinitionForProvider[];
}): Promise<{ content: string; toolCalls: ToolCallRequest[] }> {
  if (!process.env.GROK_API_KEY) throw new Error("GROK_API_KEY is not configured");
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.GROK_API_KEY}` },
    body: JSON.stringify({
      model: params.model,
      messages: turnsToOpenAIMessages(params.turns),
      temperature: TOOL_LOOP_TEMPERATURE,
      max_tokens: MAX_OUTPUT_TOKENS,
      ...(params.tools.length
        ? {
            tools: params.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
            tool_choice: "auto",
          }
        : {}),
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Grok API error ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const msg = data?.choices?.[0]?.message;
  const toolCalls: ToolCallRequest[] = (msg?.tool_calls ?? []).map((tc: { id: string; function: { name: string; arguments: string } }) => ({
    id: tc.id,
    name: tc.function.name,
    arguments: safeJsonParse(tc.function.arguments),
  }));

  return { content: msg?.content || "", toolCalls };
}

type GeminiContentPart = { text?: string; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: { name: string; response: Record<string, unknown> } };

function turnsToGeminiContents(turns: ToolTurn[]): { contents: Array<{ role: string; parts: GeminiContentPart[] }>; systemInstruction?: string } {
  const systemParts: string[] = [];
  const contents: Array<{ role: string; parts: GeminiContentPart[] }> = [];

  for (const t of turns) {
    if (t.role === "system") { systemParts.push(t.content); continue; }
    if (t.role === "user") { contents.push({ role: "user", parts: [{ text: t.content }] }); continue; }
    if (t.role === "assistant") {
      const parts: GeminiContentPart[] = [];
      if (t.content) parts.push({ text: t.content });
      for (const call of t.toolCalls ?? []) parts.push({ functionCall: { name: call.name, args: (call.arguments ?? {}) as Record<string, unknown> } });
      contents.push({ role: "model", parts });
      continue;
    }
    // Current @google/genai expects function results back on role "user", not "function".
    contents.push({ role: "user", parts: [{ functionResponse: { name: t.name, response: { content: safeJsonParse(t.content) } } }] });
  }

  return { contents, systemInstruction: systemParts.length ? systemParts.join("\n\n") : undefined };
}

async function callGeminiWithTools(params: {
  model: string;
  turns: ToolTurn[];
  tools: ToolDefinitionForProvider[];
}): Promise<{ content: string; toolCalls: ToolCallRequest[] }> {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const { contents, systemInstruction } = turnsToGeminiContents(params.turns);

  const response = await geminiClient.models.generateContent({
    model: params.model,
    contents,
    config: {
      temperature: TOOL_LOOP_TEMPERATURE,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGET },
      ...(systemInstruction ? { systemInstruction } : {}),
      ...(params.tools.length
        ? { tools: [{ functionDeclarations: params.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters })) }] }
        : {}),
    },
  });

  const candidateParts = (response.candidates?.[0]?.content?.parts ?? []) as GeminiContentPart[];
  const content = candidateParts.filter((p) => p.text).map((p) => p.text as string).join("");
  const toolCalls: ToolCallRequest[] = candidateParts
    .filter((p) => p.functionCall)
    .map((p, i) => ({ id: `${p.functionCall!.name}-${i}-${Date.now()}`, name: p.functionCall!.name, arguments: p.functionCall!.args ?? {} }));

  return { content, toolCalls };
}

async function callOllama(params: { model: string; messages: LLMMessage[] }): Promise<ProviderResponse> {
  const baseURL = process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1";
  const client = openaiClient(baseURL);
  const res = await client.chat.completions.create({
    model: params.model,
    messages: toOpenAIMessages(params.messages),
    temperature: CHAT_TEMPERATURE,
    max_tokens: MAX_OUTPUT_TOKENS,
  });
  return {
    output: res.choices[0]?.message?.content || "",
    promptTokens: res.usage?.prompt_tokens,
    completionTokens: res.usage?.completion_tokens,
    totalTokens: res.usage?.total_tokens,
  };
}
