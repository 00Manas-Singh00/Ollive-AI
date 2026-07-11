import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { generateReport } from "@/lib/conversation-report";
import { assertConversationAccess, collabErrorResponse } from "@/lib/collab";

export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;
    const result = await generateReport(id, user.id);
    return NextResponse.json(result);
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    if (error instanceof Error && error.message === "EMPTY_CONVERSATION") return NextResponse.json({ error: "Conversation has no messages" }, { status: 400 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Report generation failed" }, { status: 500 });
  }
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;
    await assertConversationAccess(user, id, "VIEWER");
    const report = await prisma.conversationReport.findUnique({ where: { conversationId: id } });
    return NextResponse.json({ report: report?.report ?? null, model: report?.model ?? null, generatedAt: report?.generatedAt ?? null });
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed to load report" }, { status: 500 });
  }
}
