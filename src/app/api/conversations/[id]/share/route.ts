import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";

export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;
    const convo = await prisma.conversation.findFirst({ where: { id, userId: user.id } });
    if (!convo) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    const shareToken = convo.shareToken || randomUUID();
    await prisma.conversation.update({ where: { id }, data: { shareToken } });
    return NextResponse.json({ shareToken, shareUrl: `/shared/${shareToken}` });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: "Failed to create share link" }, { status: 500 });
  }
}
