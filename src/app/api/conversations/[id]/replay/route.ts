import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { callLLMWithLogging, PROVIDER_NAMES, type ProviderName } from "@/lib/llm";
import { moderateInput, moderateOutput, refusalTemplate } from "@/lib/safety";
import { resolveSystemPrompt } from "@/lib/prompt-manager";
import { assertConversationAccess, collabErrorResponse } from "@/lib/collab";

const CONTEXT_WINDOW = Math.min(64, Math.max(4, Number(process.env.LLM_CONTEXT_WINDOW ?? 8) || 8));

const replayBodySchema = z.object({
  providerOverride: z.enum(PROVIDER_NAMES as [string, ...string[]]).optional(),
  promptVersionOverride: z.number().int().positive().optional(),
});

function sampleText(text: string) {
  return text.length <= 300 ? text : `${text.slice(0, 300)}...`;
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;

    const parsed = replayBodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: "Invalid replay options" }, { status: 400 });
    const { providerOverride, promptVersionOverride } = parsed.data;

    await assertConversationAccess(user, id, "COLLABORATOR");
    const original = await prisma.conversation.findFirst({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!original) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

    const userTurns = original.messages.filter((m) => m.role === "user");
    if (userTurns.length === 0) return NextResponse.json({ error: "Nothing to replay" }, { status: 400 });

    const replay = await prisma.conversation.create({
      data: {
        userId: user.id,
        title: `Replay of ${original.title}`,
        replayMeta: {
          forkedFrom: original.id,
          forkedFromTitle: original.title,
          providerOverride: providerOverride ?? null,
          promptVersionOverride: promptVersionOverride ?? null,
          startedAt: new Date().toISOString(),
        },
      },
    });

    for (const turn of userTurns) {
      const inputModeration = await moderateInput(turn.content);
      if (inputModeration.blocked) {
        const refusal = refusalTemplate(inputModeration.reason);
        await prisma.safetyAuditLog.create({
          data: { conversationId: replay.id, phase: "input", action: "blocked", reason: inputModeration.reason, categories: inputModeration.categories, sample: sampleText(turn.content) },
        });
        await prisma.chatMessage.create({ data: { conversationId: replay.id, role: "user", content: turn.content } });
        await prisma.chatMessage.create({ data: { conversationId: replay.id, role: "assistant", content: refusal } });
        continue;
      }

      await prisma.safetyAuditLog.create({
        data: { conversationId: replay.id, phase: "input", action: "allowed", categories: [], sample: sampleText(turn.content) },
      });
      await prisma.chatMessage.create({ data: { conversationId: replay.id, role: "user", content: turn.content } });

      const contextMessages = await prisma.chatMessage.findMany({
        where: { conversationId: replay.id },
        orderBy: { createdAt: "desc" },
        take: CONTEXT_WINDOW,
      });

      const promptDecision = await resolveSystemPrompt({
        conversationId: replay.id,
        versionOverride: promptVersionOverride,
        ragQuery: turn.content,
      });

      const llmMessages = [
        { role: "system" as const, content: promptDecision.prompt },
        ...contextMessages.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      ];

      const completion = await callLLMWithLogging({
        conversationId: replay.id,
        messages: llmMessages,
        providerOverride: providerOverride as ProviderName | undefined,
      });

      const outputModeration = await moderateOutput(completion.output);
      if (outputModeration.blocked) {
        const refusal = refusalTemplate(outputModeration.reason);
        await prisma.safetyAuditLog.create({
          data: { conversationId: replay.id, phase: "output", action: "blocked", reason: outputModeration.reason, categories: outputModeration.categories, sample: sampleText(completion.output) },
        });
        await prisma.chatMessage.create({ data: { conversationId: replay.id, role: "assistant", content: refusal } });
      } else {
        await prisma.safetyAuditLog.create({
          data: { conversationId: replay.id, phase: "output", action: "allowed", categories: [], sample: sampleText(completion.output) },
        });
        await prisma.chatMessage.create({ data: { conversationId: replay.id, role: "assistant", content: completion.output } });
      }
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: replay.id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

    return NextResponse.json({ conversation });
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Replay failed" }, { status: 500 });
  }
}
