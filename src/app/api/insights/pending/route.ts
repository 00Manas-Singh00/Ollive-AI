import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";

export async function GET() {
  try {
    const user = await requireSessionUser();

    const insights = await prisma.proactiveInsight.findMany({
      where: { userId: user.id, status: "PENDING" },
      orderBy: { createdAt: "desc" },
      select: {
        id: true,
        triggerReason: true,
        suggestedMessage: true,
        relatedConversationIds: true,
        createdAt: true,
      },
    });

    // Delivering a pending insight transitions it to SENT so it isn't re-surfaced.
    if (insights.length > 0) {
      await prisma.proactiveInsight.updateMany({
        where: { userId: user.id, status: "PENDING", id: { in: insights.map((i) => i.id) } },
        data: { status: "SENT" },
      });
    }

    return NextResponse.json({ insights });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
