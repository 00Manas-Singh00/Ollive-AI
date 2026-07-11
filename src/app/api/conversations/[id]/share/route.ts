import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { assertConversationAccess, collabErrorResponse } from "@/lib/collab";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;
    const { conversation: convo } = await assertConversationAccess(user, id, "OWNER");
    const shareToken = convo.shareToken || randomUUID();
    await prisma.conversation.update({ where: { id }, data: { shareToken } });
    return NextResponse.json({ shareToken, shareUrl: `/shared/${shareToken}` });
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    return NextResponse.json({ error: "Failed to create share link" }, { status: 500 });
  }
}
