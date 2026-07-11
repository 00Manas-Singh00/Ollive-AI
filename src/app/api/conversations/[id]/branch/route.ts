import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { callLLMWithLogging, PROVIDER_NAMES, type ProviderName } from "@/lib/llm";
import { moderateOutput, refusalTemplate } from "@/lib/safety";
import { resolveSystemPrompt } from "@/lib/prompt-manager";
import { assertConversationAccess, collabErrorResponse } from "@/lib/collab";

const CONTEXT_WINDOW = Math.min(64, Math.max(4, Number(process.env.LLM_CONTEXT_WINDOW ?? 8) || 8));

const branchBodySchema = z.object({
  fromMessageId: z.string().min(1),
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

    const parsed = branchBodySchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) return NextResponse.json({ error: "Invalid branch options" }, { status: 400 });
    const { fromMessageId, providerOverride, promptVersionOverride } = parsed.data;

    await assertConversationAccess(user, id, "COLLABORATOR");
    const original = await prisma.conversation.findFirst({
      where: { id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    if (!original) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

    const branchIndex = original.messages.findIndex((m) => m.id === fromMessageId);
    if (branchIndex === -1) return NextResponse.json({ error: "Branch point not found" }, { status: 404 });

    const branchPoint = original.messages[branchIndex];
    const ancestors = original.messages.slice(0, branchIndex + 1);
    const rootConversationId = original.rootConversationId ?? original.id;

    const branch = await prisma.conversation.create({
      data: {
        userId: user.id,
        title: `Branch of ${original.title}`,
        rootConversationId,
        replayMeta: {
          mode: "branch",
          forkedFrom: original.id,
          forkedFromTitle: original.title,
          branchPointMessageId: fromMessageId,
          providerOverride: providerOverride ?? null,
          promptVersionOverride: promptVersionOverride ?? null,
          startedAt: new Date().toISOString(),
        },
      },
    });

    // Clone every message up to and including the branch point verbatim. The
    // cloned branch-point message links back to the original via branchParentId.
    for (const m of ancestors) {
      await prisma.chatMessage.create({
        data: {
          conversationId: branch.id,
          role: m.role,
          content: m.content,
          ...(m.id === fromMessageId ? { branchParentId: m.id } : {}),
        },
      });
    }

    // Reuse replay's regeneration plumbing: when branching from a user turn, produce
    // a fresh assistant reply for it under the (optional) provider/prompt overrides.
    if (branchPoint.role === "user") {
      const contextMessages = await prisma.chatMessage.findMany({
        where: { conversationId: branch.id },
        orderBy: { createdAt: "desc" },
        take: CONTEXT_WINDOW,
      });

      const promptDecision = await resolveSystemPrompt({
        conversationId: branch.id,
        versionOverride: promptVersionOverride,
        ragQuery: branchPoint.content,
      });

      const llmMessages = [
        { role: "system" as const, content: promptDecision.prompt },
        ...contextMessages.reverse().map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
      ];

      const completion = await callLLMWithLogging({
        conversationId: branch.id,
        messages: llmMessages,
        providerOverride: providerOverride as ProviderName | undefined,
      });

      const outputModeration = moderateOutput(completion.output);
      if (outputModeration.blocked) {
        const refusal = refusalTemplate(outputModeration.reason);
        await prisma.safetyAuditLog.create({
          data: { conversationId: branch.id, phase: "output", action: "blocked", reason: outputModeration.reason, categories: outputModeration.categories, sample: sampleText(completion.output) },
        });
        await prisma.chatMessage.create({ data: { conversationId: branch.id, role: "assistant", content: refusal } });
      } else {
        await prisma.safetyAuditLog.create({
          data: { conversationId: branch.id, phase: "output", action: "allowed", categories: [], sample: sampleText(completion.output) },
        });
        await prisma.chatMessage.create({ data: { conversationId: branch.id, role: "assistant", content: completion.output } });
      }
    }

    const conversation = await prisma.conversation.findUnique({
      where: { id: branch.id },
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });

    return NextResponse.json({ conversation });
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Branch failed" }, { status: 500 });
  }
}
