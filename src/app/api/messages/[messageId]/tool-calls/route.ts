import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { assertConversationAccess, collabErrorResponse } from "@/lib/collab";

type Params = { params: Promise<{ messageId: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const user = await requireSessionUser();
    const { messageId } = await params;

    const message = await prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { conversationId: true },
    });
    if (!message) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await assertConversationAccess(user, message.conversationId, "VIEWER");

    const toolCalls = await prisma.toolCall.findMany({
      where: { messageId },
      orderBy: { createdAt: "asc" },
      select: { id: true, toolName: true, arguments: true, result: true, status: true, latencyMs: true },
    });

    return NextResponse.json(toolCalls);
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    const msg = error instanceof Error ? error.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
