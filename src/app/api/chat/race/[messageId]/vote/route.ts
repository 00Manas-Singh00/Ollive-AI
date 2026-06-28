import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";

const voteSchema = z.object({ raceResultId: z.string().min(1) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ messageId: string }> }) {
  try {
    const user = await requireSessionUser();
    const { messageId } = await params;
    const body = await req.json().catch(() => ({}));
    const parsed = voteSchema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: parsed.error.message }, { status: 400 });

    const message = await prisma.chatMessage.findFirst({
      where: { id: messageId, conversation: { userId: user.id } },
    });
    if (!message) return NextResponse.json({ error: "Message not found" }, { status: 404 });

    const chosen = await prisma.raceResult.findFirst({ where: { id: parsed.data.raceResultId, messageId } });
    if (!chosen) return NextResponse.json({ error: "Race result not found" }, { status: 404 });

    await prisma.$transaction([
      prisma.raceResult.updateMany({ where: { messageId, NOT: { id: chosen.id } }, data: { votedBest: false } }),
      prisma.raceResult.update({ where: { id: chosen.id }, data: { votedBest: true } }),
    ]);

    const raceResults = await prisma.raceResult.findMany({ where: { messageId }, orderBy: { createdAt: "asc" } });
    return NextResponse.json({ raceResults });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to vote";
    if (message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
