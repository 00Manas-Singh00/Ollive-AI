import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { assertConversationAccess, collabErrorResponse } from "@/lib/collab";

type ReplayMeta = {
  mode?: string;
  forkedFrom?: string;
  branchPointMessageId?: string;
} | null;

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;

    const { conversation } = await assertConversationAccess(user, id, "VIEWER");

    const rootId = conversation.rootConversationId ?? conversation.id;

    // Every conversation in the tree either is the root or points at it.
    const members = await prisma.conversation.findMany({
      where: {
        userId: user.id,
        OR: [{ id: rootId }, { rootConversationId: rootId }],
      },
      orderBy: { createdAt: "asc" },
      select: { id: true, title: true, replayMeta: true, createdAt: true },
    });

    const nodes = members.map((m) => {
      const meta = m.replayMeta as ReplayMeta;
      return {
        id: m.id,
        title: m.title,
        parentConversationId: m.id === rootId ? null : meta?.forkedFrom ?? null,
        branchPointMessageId: meta?.branchPointMessageId ?? null,
        mode: meta?.mode ?? null,
      };
    });

    return NextResponse.json({ rootId, nodes });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
