import { GoogleGenAI } from "@google/genai";
import type { LogEvent } from "@/lib/types";

type LLMMessage = { role: string; content: string };
type ProviderName = "gemini" | "grok";
type RoutingPolicy = "manual" | "cost" | "latency" | "quality";

type ProviderResponse = {
  output: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  ttftMs?: number;
  streamDurationMs?: number;
};

const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function preview(text: string, max = 280): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

async function sendLog(event: LogEvent): Promise<void> {
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

function providerModel(provider: ProviderName): string {
  return provider === "grok"
    ? process.env.GROK_MODEL || "grok-3-mini"
    : process.env.GEMINI_MODEL || "gemini-2.5-flash";
}

function configuredProviders(): ProviderName[] {
  const list: ProviderName[] = [];
  if (process.env.GEMINI_API_KEY) list.push("gemini");
  if (process.env.GROK_API_KEY) list.push("grok");
  return list;
}

function providerOrder(policy: RoutingPolicy): ProviderName[] {
  if (policy === "quality") return ["grok", "gemini"];
  if (policy === "latency") return ["gemini", "grok"];
  if (policy === "cost") return ["gemini", "grok"];
  const manual = (process.env.LLM_PROVIDER || "gemini").toLowerCase() as ProviderName;
  return manual === "grok" ? ["grok", "gemini"] : ["gemini", "grok"];
}

function getProviderPlan(): ProviderName[] {
  const policy = ((process.env.LLM_ROUTING_POLICY || "manual").toLowerCase() as RoutingPolicy);
  const configured = new Set(configuredProviders());
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
  isAborted?: () => boolean;
}): Promise<{ provider: ProviderName; model: string; response: ProviderResponse }> {
  const plan = getProviderPlan();
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

async function runProvider(params: {
  provider: ProviderName;
  model: string;
  mode: "sync" | "stream";
  messages: LLMMessage[];
  onToken?: (token: string) => void;
  isAborted?: () => boolean;
}): Promise<ProviderResponse> {
  if (params.provider === "grok") {
    const resp = await callGrok({ model: params.model, messages: params.messages });
    if (params.mode === "stream" && params.onToken && !params.isAborted?.()) {
      params.onToken(resp.output);
    }
    return resp;
  }

  if (params.mode === "stream") {
    return streamGemini({
      model: params.model,
      messages: params.messages,
      onToken: params.onToken || (() => {}),
      isAborted: params.isAborted,
    });
  }

  return callGemini({ model: params.model, messages: params.messages });
}

export async function callLLMWithLogging(params: {
  conversationId: string;
  messages: LLMMessage[];
}): Promise<{ output: string }> {
  const requestTs = new Date();
  const start = Date.now();

  try {
    const result = await executeWithFailover({
      mode: "sync",
      conversationId: params.conversationId,
      messages: params.messages,
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

    return { output: result.response.output };
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
  isAborted?: () => boolean;
}): Promise<{ output: string }> {
  const requestTs = new Date();
  const start = Date.now();

  try {
    const result = await executeWithFailover({
      mode: "stream",
      conversationId: params.conversationId,
      messages: params.messages,
      onToken: params.onToken,
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

    return { output: result.response.output };
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
    config: { temperature: 0.9, maxOutputTokens: 900 },
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
    config: { temperature: 0.9, maxOutputTokens: 900 },
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
      max_tokens: 900,
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
