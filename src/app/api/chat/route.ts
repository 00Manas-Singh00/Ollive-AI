import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { callLLMWithLogging, streamLLMWithLogging } from "@/lib/llm";
import { requireSessionUser } from "@/lib/auth";
import { moderateInput, moderateOutput, refusalTemplate } from "@/lib/safety";
import { resolveSystemPrompt } from "@/lib/prompt-manager";

const CONTEXT_WINDOW = Math.min(64, Math.max(4, Number(process.env.LLM_CONTEXT_WINDOW ?? 8) || 8));

function sampleText(text: string) {
  return text.length <= 300 ? text : `${text.slice(0, 300)}...`;
}

async function buildConversation(req: NextRequest) {
  const user = await requireSessionUser();
  const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
  if (provider === "gemini" && !process.env.GEMINI_API_KEY)
    throw Object.assign(new Error("GEMINI_API_KEY is not configured"), { status: 500 });
  if (provider === "grok" && !process.env.GROK_API_KEY)
    throw Object.assign(new Error("GROK_API_KEY is not configured"), { status: 500 });

  const body = await req.json();
  const message: string = (body.message || "").trim();
  let conversationId: string | undefined = body.conversationId;
  const promptVersionOverride: number | undefined = body.promptVersionOverride ? Number(body.promptVersionOverride) : undefined;
  if (!message) throw Object.assign(new Error("Message is required"), { status: 400 });

  let conversation;
  if (conversationId) {
    conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId: user.id } });
    if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });
    if (conversation.status === "paused")
      throw Object.assign(new Error("Conversation is paused. Resume it to continue."), { status: 409 });
  } else {
    conversation = await prisma.conversation.create({ data: { userId: user.id, title: message.slice(0, 50) } });
    conversationId = conversation.id;
  }

  const inputModeration = moderateInput(message);
  if (inputModeration.blocked) {
    const refusal = refusalTemplate(inputModeration.reason);
    await prisma.safetyAuditLog.create({
      data: { conversationId, phase: "input", action: "blocked", reason: inputModeration.reason, categories: inputModeration.categories, sample: sampleText(message) },
    });
    const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: refusal } });
    return { conversationId, blockedMessage: assistantMessage };
  }

  await prisma.safetyAuditLog.create({
    data: { conversationId, phase: "input", action: "allowed", categories: [], sample: sampleText(message) },
  });

  await prisma.chatMessage.create({ data: { conversationId, role: "user", content: message } });

  const contextMessages = await prisma.chatMessage.findMany({
    where: { conversationId },
    orderBy: { createdAt: "desc" },
    take: CONTEXT_WINDOW,
  });

  const model =
    provider === "grok"
      ? process.env.GROK_MODEL || "grok-3-mini"
      : process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const promptDecision = await resolveSystemPrompt({ conversationId, model, versionOverride: promptVersionOverride, ragQuery: message });
  const llmMessages = [
    { role: "system" as const, content: promptDecision.prompt },
    ...contextMessages.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  return { conversationId, llmMessages, blockedMessage: null };
}

export async function POST(req: NextRequest) {
  const isStreaming = req.headers.get("accept") === "text/event-stream";

  try {
    const ctx = await buildConversation(req);

    if (ctx.blockedMessage) {
      return NextResponse.json({ conversationId: ctx.conversationId, message: ctx.blockedMessage, moderated: true });
    }

    const { conversationId, llmMessages } = ctx;

    if (isStreaming) {
      let aborted = false;
      const encoder = new TextEncoder();

      const stream = new ReadableStream({
        async start(controller) {
          const send = (data: string) => controller.enqueue(encoder.encode(`data: ${data}\n\n`));

          try {
            let fullOutput = "";

            await streamLLMWithLogging({
              conversationId,
              messages: llmMessages!,
              onToken: (token) => {
                fullOutput += token;
                send(JSON.stringify({ token }));
              },
              isAborted: () => aborted,
            });

            const outputModeration = moderateOutput(fullOutput);
            if (outputModeration.blocked) {
              const refusal = refusalTemplate(outputModeration.reason);
              await prisma.safetyAuditLog.create({
                data: { conversationId, phase: "output", action: "blocked", reason: outputModeration.reason, categories: outputModeration.categories, sample: sampleText(fullOutput) },
              });
              const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: refusal } });
              send(JSON.stringify({ moderated: true, message: assistantMessage, conversationId }));
            } else {
              await prisma.safetyAuditLog.create({
                data: { conversationId, phase: "output", action: "allowed", categories: [], sample: sampleText(fullOutput) },
              });
              const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: fullOutput } });
              send(JSON.stringify({ done: true, message: assistantMessage, conversationId }));
            }
          } catch (err) {
            send(JSON.stringify({ error: err instanceof Error ? err.message : "Stream failed" }));
          } finally {
            send("[DONE]");
            controller.close();
          }
        },
        cancel() {
          aborted = true;
        },
      });

      return new Response(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        },
      });
    }

    // Sync path
    const completion = await callLLMWithLogging({ conversationId, messages: llmMessages! });

    const outputModeration = moderateOutput(completion.output);
    if (outputModeration.blocked) {
      const refusal = refusalTemplate(outputModeration.reason);
      await prisma.safetyAuditLog.create({
        data: { conversationId, phase: "output", action: "blocked", reason: outputModeration.reason, categories: outputModeration.categories, sample: sampleText(completion.output) },
      });
      const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: refusal } });
      return NextResponse.json({ conversationId, message: assistantMessage, moderated: true });
    }

    await prisma.safetyAuditLog.create({
      data: { conversationId, phase: "output", action: "allowed", categories: [], sample: sampleText(completion.output) },
    });
    const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: completion.output } });
    return NextResponse.json({ conversationId, message: assistantMessage });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to process chat";
    if (message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
