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

    const citations = await prisma.messageCitation.findMany({
      where: { messageId },
      orderBy: { relevanceScore: "desc" },
      include: {
        chunk: {
          select: {
            id: true,
            chunkIndex: true,
            text: true,
            document: { select: { id: true, filename: true } },
          },
        },
      },
    });

    return NextResponse.json(
      citations.map((c) => ({
        id: c.id,
        chunkId: c.chunkId,
        relevanceScore: c.relevanceScore,
        excerptStart: c.excerptStart,
        excerptEnd: c.excerptEnd,
        chunkText: c.chunk.text,
        chunkIndex: c.chunk.chunkIndex,
        documentId: c.chunk.document.id,
        filename: c.chunk.document.filename,
      })),
    );
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    const msg = error instanceof Error ? error.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
