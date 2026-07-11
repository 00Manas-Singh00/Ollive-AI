import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { assertConversationAccess, collabErrorResponse } from "@/lib/collab";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;
    await assertConversationAccess(user, id, "COLLABORATOR");
    const body = await req.json().catch(() => ({}));
    const action = body?.action === "resume" ? "resume" : "pause";
    const status = action === "resume" ? "active" : "paused";

    const conversation = await prisma.conversation.update({
      where: { id },
      data: { status },
    });

    return NextResponse.json({ conversation });
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update conversation" },
      { status: 500 }
    );
  }
}
