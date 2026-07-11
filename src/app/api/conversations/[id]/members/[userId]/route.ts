import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { assertConversationAccess, collabErrorResponse } from "@/lib/collab";

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string; userId: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id, userId } = await params;

    // A member may remove themself (leave); otherwise removal is owner-only.
    if (userId !== user.id) {
      await assertConversationAccess(user, id, "OWNER");
    } else {
      await assertConversationAccess(user, id, "VIEWER");
    }

    await prisma.conversationMember.deleteMany({ where: { conversationId: id, userId } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
