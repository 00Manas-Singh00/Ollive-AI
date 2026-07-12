import { randomUUID } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { moderateInput, moderateOutput, refusalTemplate } from "@/lib/safety";
import { resolveSystemPrompt } from "@/lib/prompt-manager";
import { configuredProviders, providerModel, runProvider, sendLog, preview, PROVIDER_NAMES, type ProviderName } from "@/lib/llm";
import { assertConversationAccess, collabErrorResponse } from "@/lib/collab";

const CONTEXT_WINDOW = Math.min(64, Math.max(4, Number(process.env.LLM_CONTEXT_WINDOW ?? 8) || 8));

const racePayloadSchema = z.object({
  conversationId: z.string().min(1).optional(),
  content: z.string().min(1),
  providers: z.array(z.enum(PROVIDER_NAMES as [ProviderName, ...ProviderName[]])).min(2).max(3),
});

function sampleText(text: string) {
  return text.length <= 300 ? text : `${text.slice(0, 300)}...`;
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireSessionUser();
    const body = await req.json();
    const parsed = racePayloadSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });
    const { content, providers } = parsed.data;
    let conversationId = parsed.data.conversationId;

    const configured = new Set(configuredProviders());
    const unconfigured = providers.filter((p) => !configured.has(p));
    if (unconfigured.length) {
      return NextResponse.json({ error: `Provider(s) not configured: ${unconfigured.join(", ")}` }, { status: 400 });
    }

    if (conversationId) {
      const { conversation } = await assertConversationAccess(user, conversationId, "COLLABORATOR");
      if (conversation.status === "paused")
        return NextResponse.json({ error: "Conversation is paused. Resume it to continue." }, { status: 409 });
    } else {
      const conversation = await prisma.conversation.create({ data: { userId: user.id, title: content.slice(0, 50) } });
      conversationId = conversation.id;
    }

    const inputModeration = moderateInput(content);
    if (inputModeration.blocked) {
      const refusal = refusalTemplate(inputModeration.reason);
      await prisma.safetyAuditLog.create({
        data: { conversationId, phase: "input", action: "blocked", reason: inputModeration.reason, categories: inputModeration.categories, sample: sampleText(content) },
      });
      const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: refusal } });
      return NextResponse.json({ conversationId, blockedMessage: assistantMessage, moderated: true });
    }

    await prisma.safetyAuditLog.create({
      data: { conversationId, phase: "input", action: "allowed", categories: [], sample: sampleText(content) },
    });

    const userMessage = await prisma.chatMessage.create({ data: { conversationId, role: "user", content } });

    const contextMessages = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: CONTEXT_WINDOW,
    });

    const promptDecision = await resolveSystemPrompt({ conversationId, ragQuery: content });
    const llmMessages = [
      { role: "system" as const, content: promptDecision.prompt },
      ...contextMessages.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    const settled = await Promise.allSettled(
      providers.map(async (provider) => {
        const model = providerModel(provider);
        const start = Date.now();
        const requestTs = new Date();
        try {
          const response = await runProvider({ provider, model, mode: "sync", messages: llmMessages });
          const latencyMs = Date.now() - start;

          let outputContent = response.output;
          const outputModeration = moderateOutput(outputContent);
          await prisma.safetyAuditLog.create({
            data: {
              conversationId,
              phase: "output",
              action: outputModeration.blocked ? "blocked" : "allowed",
              reason: outputModeration.reason,
              categories: outputModeration.categories,
              sample: sampleText(outputContent),
            },
          });
          if (outputModeration.blocked) outputContent = refusalTemplate(outputModeration.reason);

          const raceResult = await prisma.raceResult.create({
            data: {
              messageId: userMessage.id,
              provider,
              model,
              content: outputContent,
              latencyMs,
              tokenCount: response.totalTokens,
            },
          });

          void sendLog({
            eventId: randomUUID(),
            conversationId,
            provider,
            model,
            status: "success",
            mode: "sync",
            latencyMs,
            promptTokens: response.promptTokens,
            completionTokens: response.completionTokens,
            totalTokens: response.totalTokens,
            requestTs: requestTs.toISOString(),
            responseTs: new Date().toISOString(),
            inputPreview: preview(content),
            outputPreview: preview(outputContent),
          });

          return raceResult;
        } catch (error) {
          void sendLog({
            eventId: randomUUID(),
            conversationId,
            provider,
            model,
            status: "error",
            mode: "sync",
            latencyMs: Date.now() - start,
            requestTs: requestTs.toISOString(),
            responseTs: new Date().toISOString(),
            inputPreview: preview(content),
            errorMessage: error instanceof Error ? error.message : "Unknown error",
          });
          throw error;
        }
      }),
    );

    const raceResults = settled.filter((r) => r.status === "fulfilled").map((r) => r.value);
    const errors = settled
      .map((r, i) => (r.status === "rejected" ? { provider: providers[i], error: r.reason instanceof Error ? r.reason.message : "Unknown error" } : null))
      .filter((e): e is { provider: ProviderName; error: string } => e !== null);

    return NextResponse.json({ conversationId, userMessage, raceResults, errors });
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    const message = error instanceof Error ? error.message : "Failed to process race request";
    return NextResponse.json({ error: `Race request failed: ${message}` }, { status: 502 });
  }
}
