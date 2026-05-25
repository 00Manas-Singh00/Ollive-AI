import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { callLLMWithLogging } from "@/lib/llm";

export async function POST(req: NextRequest) {
  try {
    const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
    if (provider === "gemini" && !process.env.GEMINI_API_KEY) {
      return NextResponse.json({ error: "GEMINI_API_KEY is not configured" }, { status: 500 });
    }
    if (provider === "grok" && !process.env.GROK_API_KEY) {
      return NextResponse.json({ error: "GROK_API_KEY is not configured" }, { status: 500 });
    }

    const body = await req.json();
    const message: string = (body.message || "").trim();
    let conversationId: string | undefined = body.conversationId;

    if (!message) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    let conversation;
    if (conversationId) {
      conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
      if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
      if (conversation.status === "paused") {
        return NextResponse.json({ error: "Conversation is paused. Resume it to continue." }, { status: 409 });
      }
    } else {
      conversation = await prisma.conversation.create({
        data: {
          title: message.slice(0, 50),
        },
      });
      conversationId = conversation.id;
    }

    await prisma.chatMessage.create({
      data: {
        conversationId,
        role: "user",
        content: message,
      },
    });

    const contextMessages = await prisma.chatMessage.findMany({
      where: { conversationId },
      orderBy: { createdAt: "desc" },
      take: 8,
    });

    const llmMessages = [
      { role: "system" as const, content: "You are a concise, helpful assistant. Avoid repeating the same responses in a conversation. Prefer fresh, original responses." },
      ...contextMessages.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];

    const completion = await callLLMWithLogging({
      conversationId,
      messages: llmMessages,
    });

    const assistantMessage = await prisma.chatMessage.create({
      data: {
        conversationId,
        role: "assistant",
        content: completion.output,
      },
    });

    return NextResponse.json({
      conversationId,
      message: assistantMessage,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to process chat";
    const lower = message.toLowerCase();

    if (lower.includes("incorrect api key") || lower.includes("invalid api key") || lower.includes("unauthorized")) {
      return NextResponse.json({ error: `Provider auth error: ${message}` }, { status: 401 });
    }
    if (
      lower.includes("rate limit") ||
      lower.includes("quota") ||
      lower.includes("insufficient_quota")
    ) {
      return NextResponse.json({ error: `Provider quota/rate-limit error: ${message}` }, { status: 429 });
    }
    if (lower.includes("model") && (lower.includes("not found") || lower.includes("does not exist"))) {
      return NextResponse.json({ error: `Model configuration error: ${message}` }, { status: 400 });
    }

    return NextResponse.json(
      { error: `Chat request failed: ${message}` },
      { status: 502 }
    );
  }
}
