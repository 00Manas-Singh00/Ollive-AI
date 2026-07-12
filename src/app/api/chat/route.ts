import { randomUUID } from "crypto";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { callLLMWithLogging, streamLLMWithLogging, getProviderPlan, providerModel, sendLog } from "@/lib/llm";
import { requireSessionUser } from "@/lib/auth";
import { moderateInput, moderateOutput, refusalTemplate } from "@/lib/safety";
import { resolveSystemPrompt } from "@/lib/prompt-manager";
import { persistCitations } from "@/lib/rag";
import { persistReasoningTrace } from "@/lib/reasoning-trace";
import { parseWidgetDirective, createWidgetStripper, WIDGET_SUFFIX } from "@/lib/generative-ui";
import { getQualityScoreQueue, getEmbeddingQueue } from "@/lib/queue";
import { checkRateLimit } from "@/lib/rate-limiter";
import { checkBudget, downgradeProvider } from "@/lib/budget";
import { runToolLoop } from "@/lib/tools/loop";
import { assertConversationAccess, collabErrorResponse, publishConversationEvent, acquireSendLock, releaseSendLock } from "@/lib/collab";
import type { ProviderName } from "@/lib/llm";

const toolsEnabledSchema = z.boolean().optional();

const CONTEXT_WINDOW = Math.min(64, Math.max(4, Number(process.env.LLM_CONTEXT_WINDOW ?? 8) || 8));

function sampleText(text: string) {
  return text.length <= 300 ? text : `${text.slice(0, 300)}...`;
}

function enqueueQualityScore(messageId: string) {
  if (!process.env.REDIS_URL) return;
  void getQualityScoreQueue().add("score", { messageId });
}

// Phase 16: the embedding worker embeds every un-embedded message in the
// conversation, so one job per turn covers the user + assistant messages.
function enqueueEmbedding(conversationId: string) {
  if (!process.env.REDIS_URL) return;
  void getEmbeddingQueue().add("embed", { conversationId });
}

async function buildConversation(req: NextRequest) {
  const user = await requireSessionUser();

  if (process.env.REDIS_URL && !user.rateLimitExempt) {
    const rateLimit = await checkRateLimit(user.id);
    if (rateLimit.limited) {
      throw Object.assign(new Error("Rate limit exceeded"), {
        status: 429,
        rateLimitHeaders: {
          "X-RateLimit-Limit": String(rateLimit.limit),
          "X-RateLimit-Remaining": String(rateLimit.remaining),
          "X-RateLimit-Window": `${rateLimit.windowSeconds}s`,
        },
      });
    }
  }

  // Phase 22: budget guardrails — after auth + rate limiting, before any LLM work.
  let providerOverride: ProviderName | undefined;
  let modelOverride: string | undefined;
  const budgetHeaders: Record<string, string> = {};
  const budget = await checkBudget(user.id);
  if (budget.status === "exceeded" && budget.action === "BLOCK") {
    throw Object.assign(
      new Error("Monthly budget exceeded. Chat is paused until next month or until an admin raises your budget."),
      { status: 402 },
    );
  }
  if (budget.status === "exceeded" && budget.action === "DOWNGRADE") {
    const fallback = downgradeProvider();
    providerOverride = fallback.provider;
    modelOverride = fallback.model;
    budgetHeaders["x-budget-downgraded"] = "true";
  } else if (budget.status === "warning" || budget.status === "exceeded") {
    budgetHeaders["x-budget-warning"] = "true";
  }

  const body = await req.json();
  const message: string = (body.message || "").trim();
  let conversationId: string | undefined = body.conversationId;
  const promptVersionOverride: number | undefined = body.promptVersionOverride ? Number(body.promptVersionOverride) : undefined;
  const toolsEnabled = toolsEnabledSchema.parse(body.toolsEnabled) ?? false;
  if (!message) throw Object.assign(new Error("Message is required"), { status: 400 });

  let conversation;
  if (conversationId) {
    const access = await assertConversationAccess(user, conversationId, "COLLABORATOR");
    conversation = access.conversation;
    if (conversation.status === "paused")
      throw Object.assign(new Error("Conversation is paused. Resume it to continue."), { status: 409 });
  } else {
    conversation = await prisma.conversation.create({ data: { userId: user.id, title: message.slice(0, 50) } });
    conversationId = conversation.id;
  }
  const isCollaborative = conversation.isCollaborative;

  const inputModeration = await moderateInput(message);
  if (inputModeration.blocked) {
    const refusal = refusalTemplate(inputModeration.reason);
    await prisma.safetyAuditLog.create({
      data: { conversationId, phase: "input", action: "blocked", reason: inputModeration.reason, categories: inputModeration.categories, sample: sampleText(message) },
    });
    const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: refusal } });
    return { conversationId, blockedMessage: assistantMessage, budgetHeaders };
  }

  await prisma.safetyAuditLog.create({
    data: { conversationId, phase: "input", action: "allowed", categories: [], sample: sampleText(message) },
  });

  const userMessage = await prisma.chatMessage.create({ data: { conversationId, role: "user", content: message } });
  if (isCollaborative) void publishConversationEvent(conversationId, { type: "message_created", message: userMessage });

  const contextMessages = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: CONTEXT_WINDOW,
  });

  const resolvedProvider = providerOverride || getProviderPlan()[0];
  const model = (providerOverride && modelOverride) || providerModel(resolvedProvider);

  const promptDecision = await resolveSystemPrompt({ conversationId, userId: user.id, model, versionOverride: promptVersionOverride, ragQuery: message });
  const llmMessages = [
    { role: "system" as const, content: `${promptDecision.prompt}\n\n${WIDGET_SUFFIX}` },
    ...contextMessages.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  return {
    conversationId,
    llmMessages,
    ragChunks: promptDecision.ragChunks,
    blockedMessage: null,
    providerOverride,
    modelOverride,
    budgetHeaders,
    toolsEnabled,
    userId: user.id,
    isCollaborative,
  };
}

export async function POST(req: NextRequest) {
  const isStreaming = req.headers.get("accept") === "text/event-stream";
  // Safety-net release if an exception unwinds past the explicit release calls below.
  let lockedConversationId: string | null = null;

  try {
    const ctx = await buildConversation(req);

    if (ctx.blockedMessage) {
      return NextResponse.json(
        { conversationId: ctx.conversationId, message: ctx.blockedMessage, moderated: true },
        { headers: ctx.budgetHeaders },
      );
    }

    const { conversationId, llmMessages, ragChunks, providerOverride, modelOverride, budgetHeaders, toolsEnabled, userId, isCollaborative } = ctx;

    // Only one member may have an in-flight send per collaborative conversation.
    // Released in the stream's finally (streaming path) or below (sync path) —
    // never right after this check, since streaming keeps generating long after
    // the Response object is constructed and returned.
    if (isCollaborative && !(await acquireSendLock(conversationId))) {
      throw Object.assign(new Error("Another member is currently sending a message in this conversation"), { status: 409 });
    }
    if (isCollaborative) lockedConversationId = conversationId;

    // Tool loops are sync-mode only (see src/lib/tools/loop.ts) — a tools-enabled
    // request always answers via the JSON path even if the client asked for SSE.
    if (isStreaming && !toolsEnabled) {
      let aborted = false;
      const encoder = new TextEncoder();
      // One id for the whole in-flight assistant turn — collaborators correlate live
      // token/thought events to the eventual persisted message via this id (previously
      // these events carried conversationId, which isn't a message id at all).
      const pendingMessageId = randomUUID();

      const stream = new ReadableStream({
        async start(controller) {
          const send = (data: Record<string, unknown>) => {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
            if (isCollaborative) {
              if (typeof data.token === "string") {
                void publishConversationEvent(conversationId, { type: "token", messageId: pendingMessageId, token: data.token });
              } else if (typeof data.thought === "string") {
                void publishConversationEvent(conversationId, { type: "thought", messageId: pendingMessageId, thought: data.thought });
              }
            }
          };
          const sendDone = () => controller.enqueue(encoder.encode("data: [DONE]\n\n"));

          try {
            let fullOutput = "";
            let thinkingText = "";

            // Keep the raw response in fullOutput for widget parsing, but strip the
            // ```widget block out of the live token stream so it never renders.
            const widgetStripper = createWidgetStripper((token) => send({ token }));

            const streamResult = await streamLLMWithLogging({
              conversationId,
              messages: llmMessages!,
              onToken: (token) => {
                fullOutput += token;
                widgetStripper.push(token);
              },
              onThought: (thought) => {
                thinkingText += (thinkingText ? "\n" : "") + thought;
                send({ thought });
              },
              isAborted: () => aborted,
              providerOverride,
              modelOverride,
            });
            widgetStripper.flush();

            const outputModeration = await moderateOutput(fullOutput);
            if (outputModeration.blocked) {
              const refusal = refusalTemplate(outputModeration.reason);
              await prisma.safetyAuditLog.create({
                data: { conversationId, phase: "output", action: "blocked", reason: outputModeration.reason, categories: outputModeration.categories, sample: sampleText(fullOutput) },
              });
              const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: refusal } });
              send({ moderated: true, message: assistantMessage, conversationId });
            } else {
              await prisma.safetyAuditLog.create({
                data: { conversationId, phase: "output", action: "allowed", categories: [], sample: sampleText(fullOutput) },
              });
              const { widget, text: displayText } = parseWidgetDirective(fullOutput);
              const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: displayText } });
              const widgetInteraction = widget
                ? await prisma.widgetInteraction.create({ data: { messageId: assistantMessage.id, widgetType: widget.type, schema: widget } })
                : null;
              await persistCitations(assistantMessage.id, ragChunks ?? []);
              enqueueQualityScore(assistantMessage.id);
              enqueueEmbedding(conversationId);
              persistReasoningTrace({ messageId: assistantMessage.id, provider: streamResult.provider, thinkingText });
              send({ done: true, message: assistantMessage, widget: widgetInteraction, conversationId, provider: streamResult.provider, model: streamResult.model, pendingMessageId });
              if (isCollaborative) void publishConversationEvent(conversationId, { type: "message_created", message: assistantMessage });
            }
          } catch (err) {
            send({ error: err instanceof Error ? err.message : "Stream failed" });
          } finally {
            sendDone();
            controller.close();
            if (isCollaborative) void releaseSendLock(conversationId);
          }
        },
        cancel() {
          aborted = true;
          if (isCollaborative) void releaseSendLock(conversationId);
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
          ...budgetHeaders,
        },
      });
    }

    // Sync path
    let completion: { output: string; provider: ProviderName; model: string };
    let toolCallRecords: Awaited<ReturnType<typeof runToolLoop>>["toolCalls"] = [];

    if (toolsEnabled) {
      const [provider] = getProviderPlan(providerOverride);
      const model = (providerOverride && modelOverride) || providerModel(provider);
      const start = Date.now();
      const result = await runToolLoop({ provider, model, messages: llmMessages!, conversationId, userId: userId! });
      toolCallRecords = result.toolCalls;
      completion = { output: result.output, provider, model };
      void sendLog({
        eventId: randomUUID(),
        conversationId,
        provider,
        model,
        status: "success",
        mode: "sync",
        latencyMs: Date.now() - start,
        requestTs: new Date(start).toISOString(),
        responseTs: new Date().toISOString(),
        inputPreview: llmMessages!.map((m) => `${m.role}: ${m.content}`).join("\n").slice(0, 280),
        outputPreview: result.output.slice(0, 280),
      });
    } else {
      completion = await callLLMWithLogging({ conversationId, messages: llmMessages!, providerOverride, modelOverride });
    }

    const outputModeration = await moderateOutput(completion.output);
    if (outputModeration.blocked) {
      const refusal = refusalTemplate(outputModeration.reason);
      await prisma.safetyAuditLog.create({
        data: { conversationId, phase: "output", action: "blocked", reason: outputModeration.reason, categories: outputModeration.categories, sample: sampleText(completion.output) },
      });
      const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: refusal } });
      if (isCollaborative) void releaseSendLock(conversationId);
      return NextResponse.json({ conversationId, message: assistantMessage, moderated: true }, { headers: budgetHeaders });
    }

    await prisma.safetyAuditLog.create({
      data: { conversationId, phase: "output", action: "allowed", categories: [], sample: sampleText(completion.output) },
    });
    const { widget, text: displayText } = parseWidgetDirective(completion.output);
    const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: displayText } });
    const widgetInteraction = widget
      ? await prisma.widgetInteraction.create({ data: { messageId: assistantMessage.id, widgetType: widget.type, schema: widget } })
      : null;
    await persistCitations(assistantMessage.id, ragChunks ?? []);
    if (toolCallRecords.length) {
      await prisma.toolCall.createMany({
        data: toolCallRecords.map((t) => ({
          messageId: assistantMessage.id,
          toolName: t.toolName,
          arguments: t.arguments as Prisma.InputJsonValue,
          result: t.result as Prisma.InputJsonValue,
          status: t.status,
          latencyMs: t.latencyMs,
        })),
      });
    }
    enqueueQualityScore(assistantMessage.id);
    enqueueEmbedding(conversationId);
    if (isCollaborative) {
      void releaseSendLock(conversationId);
      void publishConversationEvent(conversationId, { type: "message_created", message: assistantMessage });
    }
    return NextResponse.json(
      {
        conversationId,
        message: assistantMessage,
        widget: widgetInteraction,
        toolCalls: toolCallRecords.length ? toolCallRecords : undefined,
        provider: completion.provider,
        model: completion.model,
      },
      { headers: budgetHeaders },
    );
  } catch (error) {
    if (lockedConversationId) void releaseSendLock(lockedConversationId);
    const message = error instanceof Error ? error.message : "Failed to process chat";
    if (message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    const rateLimitHeaders = (error as { rateLimitHeaders?: Record<string, string> }).rateLimitHeaders;
    if (rateLimitHeaders)
      return NextResponse.json({ error: message }, { status: 429, headers: rateLimitHeaders });
    const lower = message.toLowerCase();
    if (lower.includes("incorrect api key") || lower.includes("invalid api key") || lower.includes("unauthorized"))
      return NextResponse.json({ error: `Provider auth error: ${message}` }, { status: 401 });
    if (lower.includes("rate limit") || lower.includes("quota") || lower.includes("insufficient_quota"))
      return NextResponse.json({ error: `Provider quota/rate-limit error: ${message}` }, { status: 429 });
    if (lower.includes("model") && (lower.includes("not found") || lower.includes("does not exist")))
      return NextResponse.json({ error: `Model configuration error: ${message}` }, { status: 400 });
    const status = (error as { status?: number }).status;
    if (status) return NextResponse.json({ error: message }, { status });
    return NextResponse.json({ error: `Chat request failed: ${message}` }, { status: 502 });
  }
}
