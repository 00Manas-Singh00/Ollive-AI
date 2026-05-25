import { GoogleGenAI } from "@google/genai";
import type { LogEvent } from "@/lib/types";

type LLMMessage = { role: string; content: string };
type ProviderName = "gemini" | "grok";

const geminiClient = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

function preview(text: string, max = 280): string {
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

async function sendLog(event: LogEvent): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "http://localhost:3000";
  try {
    await fetch(`${baseUrl}/api/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event),
      cache: "no-store",
    });
  } catch {}
}

function getProviderAndModel() {
  const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase() as ProviderName;
  const model =
    provider === "grok"
      ? process.env.GROK_MODEL || "grok-3-mini"
      : process.env.GEMINI_MODEL || "gemini-2.5-flash";
  return { provider, model };
}

export async function callLLMWithLogging(params: {
  conversationId: string;
  messages: LLMMessage[];
}): Promise<{ output: string }> {
  const { provider, model } = getProviderAndModel();
  const requestTs = new Date();
  const start = Date.now();

  try {
    const providerResponse =
      provider === "grok"
        ? await callGrok({ model, messages: params.messages })
        : await callGemini({ model, messages: params.messages });
    const responseTs = new Date();

    await sendLog({
      conversationId: params.conversationId,
      provider,
      model,
      status: "success",
      mode: "sync",
      latencyMs: Date.now() - start,
      promptTokens: providerResponse.promptTokens,
      completionTokens: providerResponse.completionTokens,
      totalTokens: providerResponse.totalTokens,
      requestTs: requestTs.toISOString(),
      responseTs: responseTs.toISOString(),
      inputPreview: preview(params.messages.map((m) => `${m.role}: ${m.content}`).join("\n")),
      outputPreview: preview(providerResponse.output),
    });

    return { output: providerResponse.output };
  } catch (error) {
    const responseTs = new Date();
    await sendLog({
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
  isAborted?: () => boolean;
}): Promise<{ output: string }> {
  const { provider, model } = getProviderAndModel();
  const requestTs = new Date();
  const start = Date.now();

  try {
    const providerResponse =
      provider === "grok"
        ? await callGrok({ model, messages: params.messages })
        : await streamGemini({ model, messages: params.messages, onToken: params.onToken, isAborted: params.isAborted });

    if (provider === "grok" && !params.isAborted?.()) {
      params.onToken(providerResponse.output);
    }

    const responseTs = new Date();
    await sendLog({
      conversationId: params.conversationId,
      provider,
      model,
      status: params.isAborted?.() ? "error" : "success",
      mode: "stream",
      latencyMs: Date.now() - start,
      ttftMs: providerResponse.ttftMs,
      streamDurationMs: providerResponse.streamDurationMs ?? Date.now() - start,
      promptTokens: providerResponse.promptTokens,
      completionTokens: providerResponse.completionTokens,
      totalTokens: providerResponse.totalTokens,
      requestTs: requestTs.toISOString(),
      responseTs: responseTs.toISOString(),
      inputPreview: preview(params.messages.map((m) => `${m.role}: ${m.content}`).join("\n")),
      outputPreview: preview(providerResponse.output),
      errorMessage: params.isAborted?.() ? "stream_aborted_by_user" : undefined,
    });

    return { output: providerResponse.output };
  } catch (error) {
    const responseTs = new Date();
    await sendLog({
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

async function callGemini(params: { model: string; messages: LLMMessage[] }) {
  if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured");
  const prompt = params.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const response = await geminiClient.models.generateContent({
    model: params.model,
    contents: prompt,
    config: { temperature: 0.5, maxOutputTokens: 900 },
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
  const prompt = params.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const startedAt = Date.now();
  let firstTokenAt: number | null = null;
  let output = "";

  const stream = await geminiClient.models.generateContentStream({
    model: params.model,
    contents: prompt,
    config: { temperature: 0.9, maxOutputTokens: 900 },
  });

  for await (const chunk of stream) {
    if (params.isAborted?.()) break;
    const token = chunk.text || "";
    if (!token) continue;
    if (firstTokenAt === null) firstTokenAt = Date.now();
    output += token;
    params.onToken(token);
  }

  const finalResponse = await stream.response;
  const finalText = (finalResponse as any)?.text || "";
  if (!output && finalText) output = finalText;
  return {
    output,
    ttftMs: firstTokenAt ? firstTokenAt - startedAt : undefined,
    streamDurationMs: Date.now() - startedAt,
    promptTokens: finalResponse.usageMetadata?.promptTokenCount,
    completionTokens: finalResponse.usageMetadata?.candidatesTokenCount,
    totalTokens: finalResponse.usageMetadata?.totalTokenCount,
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
