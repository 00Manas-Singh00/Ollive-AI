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

export async function callLLMWithLogging(params: {
  conversationId: string;
  messages: LLMMessage[];
}): Promise<{ output: string }> {
  const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase() as ProviderName;
  const model =
    provider === "grok"
      ? process.env.GROK_MODEL || "grok-3-mini"
      : process.env.GEMINI_MODEL || "gemini-2.5-flash";
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
      latencyMs: Date.now() - start,
      promptTokens: providerResponse.promptTokens,
      completionTokens: providerResponse.completionTokens,
      totalTokens: providerResponse.totalTokens,
      requestTs: requestTs.toISOString(),
      responseTs: responseTs.toISOString(),
      inputPreview: preview(
        params.messages.map((m) => `${m.role}: ${m.content}`).join("\n")
      ),
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
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured");
  }
  const prompt = params.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
  const response = await geminiClient.models.generateContent({
    model: params.model,
    contents: prompt,
    config: { temperature: 0.5, maxOutputTokens: 300 },
  });

  return {
    output: response.text || "",
    promptTokens: response.usageMetadata?.promptTokenCount,
    completionTokens: response.usageMetadata?.candidatesTokenCount,
    totalTokens: response.usageMetadata?.totalTokenCount,
  };
}

async function callGrok(params: { model: string; messages: LLMMessage[] }) {
  if (!process.env.GROK_API_KEY) {
    throw new Error("GROK_API_KEY is not configured");
  }
  const response = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROK_API_KEY}`,
    },
    body: JSON.stringify({
      model: params.model,
      messages: params.messages,
      temperature: 0.5,
      max_tokens: 300,
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
