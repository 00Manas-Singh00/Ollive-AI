import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { callLLMWithLogging } from "@/lib/llm";
import { moderateInput, moderateOutput, refusalTemplate } from "@/lib/safety";
import { resolveSystemPrompt } from "@/lib/prompt-manager";
import { requireEmbedToken, corsHeaders } from "@/lib/embed-auth";

const ChatPayload = z.object({
  message: z.string().min(1),
  conversationId: z.string().optional(),
});

function sampleText(text: string) {
  return text.length <= 300 ? text : `${text.slice(0, 300)}...`;
}

export async function OPTIONS(req: NextRequest) {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": req.headers.get("origin") ?? "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, X-Embed-Token",
    },
  });
}

export async function POST(req: NextRequest) {
  let embedToken;
  try {
    embedToken = await requireEmbedToken(req);
  } catch (error) {
    const status = (error as { status?: number }).status ?? 401;
    const message = error instanceof Error ? error.message : "Unauthorized";
    return NextResponse.json({ error: message }, { status });
  }

  const headers = corsHeaders(req, embedToken);

  try {
    const body = ChatPayload.parse(await req.json());

    let conversation;
    if (body.conversationId) {
      conversation = await prisma.conversation.findFirst({
        where: { id: body.conversationId, userId: embedToken.userId },
      });
      if (!conversation) throw Object.assign(new Error("Conversation not found"), { status: 404 });
    } else {
      conversation = await prisma.conversation.create({
        data: { userId: embedToken.userId, title: body.message.slice(0, 50) },
      });
    }
    const conversationId = conversation.id;

    const inputModeration = await moderateInput(body.message);
    if (inputModeration.blocked) {
      const refusal = refusalTemplate(inputModeration.reason);
      await prisma.safetyAuditLog.create({
        data: { conversationId, phase: "input", action: "blocked", reason: inputModeration.reason, categories: inputModeration.categories, sample: sampleText(body.message) },
      });
      const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: refusal } });
      return NextResponse.json({ conversationId, message: assistantMessage, moderated: true }, { headers });
    }

    await prisma.safetyAuditLog.create({
      data: { conversationId, phase: "input", action: "allowed", categories: [], sample: sampleText(body.message) },
    });
    await prisma.chatMessage.create({ data: { conversationId, role: "user", content: body.message } });

    const promptDecision = await resolveSystemPrompt({
      conversationId,
      ragQuery: body.message,
      profileKey: embedToken.promptProfileKey ?? undefined,
    });

    const contextMessages = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: 8,
    });

    const llmMessages = [
      { role: "system" as const, content: promptDecision.prompt },
      ...contextMessages.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    const completion = await callLLMWithLogging({ conversationId, messages: llmMessages });

    const outputModeration = await moderateOutput(completion.output);
    if (outputModeration.blocked) {
      const refusal = refusalTemplate(outputModeration.reason);
      await prisma.safetyAuditLog.create({
        data: { conversationId, phase: "output", action: "blocked", reason: outputModeration.reason, categories: outputModeration.categories, sample: sampleText(completion.output) },
      });
      const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: refusal } });
      return NextResponse.json({ conversationId, message: assistantMessage, moderated: true }, { headers });
    }

    await prisma.safetyAuditLog.create({
      data: { conversationId, phase: "output", action: "allowed", categories: [], sample: sampleText(completion.output) },
    });
    const assistantMessage = await prisma.chatMessage.create({ data: { conversationId, role: "assistant", content: completion.output } });

    return NextResponse.json({ conversationId, message: assistantMessage }, { headers });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to process chat";
    const status = (error as { status?: number }).status ?? 500;
    return NextResponse.json({ error: message }, { status, headers });
  }
}
