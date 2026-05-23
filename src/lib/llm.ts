import { GoogleGenAI } from "@google/genai";
import type { LogEvent } from "@/lib/types";

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

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
  messages: Array<{ role: string; content: string }>;
}): Promise<{ output: string }> {
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const provider = "gemini";
  const requestTs = new Date();
  const start = Date.now();

  try {
    const prompt = params.messages.map((m) => `${m.role}: ${m.content}`).join("\n");
    const response = await client.models.generateContent({
      model,
      contents: prompt,
      config: { temperature: 0.5, maxOutputTokens: 300 },
    });

    const output = response.text || "";
    const responseTs = new Date();

    await sendLog({
      conversationId: params.conversationId,
      provider,
      model,
      status: "success",
      latencyMs: Date.now() - start,
      promptTokens: response.usageMetadata?.promptTokenCount,
      completionTokens: response.usageMetadata?.candidatesTokenCount,
      totalTokens: response.usageMetadata?.totalTokenCount,
      requestTs: requestTs.toISOString(),
      responseTs: responseTs.toISOString(),
      inputPreview: preview(
        params.messages.map((m) => `${m.role}: ${m.content}`).join("\n")
      ),
      outputPreview: preview(output),
    });

    return { output };
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
