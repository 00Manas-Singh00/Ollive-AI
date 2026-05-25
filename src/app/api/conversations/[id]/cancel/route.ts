import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const action = body?.action === "resume" ? "resume" : "pause";
    const status = action === "resume" ? "active" : "paused";

    const conversation = await prisma.conversation.update({
      where: { id },
      data: { status },
    });

    return NextResponse.json({ conversation });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update conversation" },
      { status: 500 }
    );
  }
}
