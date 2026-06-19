import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { calculateCostUsd } from "@/lib/cost";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const user = await requireSessionUser();
    if (!user.isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { searchParams } = req.nextUrl;
    const from = searchParams.get("from") ? new Date(searchParams.get("from")!) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const to = searchParams.get("to") ? new Date(searchParams.get("to")!) : new Date();

    const logs = await prisma.inferenceLog.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: {
        provider: true,
        model: true,
        promptTokens: true,
        completionTokens: true,
        createdAt: true,
        conversation: { select: { userId: true } },
      },
    });

    const byUser: Record<string, number> = {};
    const byProvider: Record<string, number> = {};
    const series: Record<string, number> = {};
    let totalUsd = 0;

    for (const log of logs) {
      const cost = calculateCostUsd(log.provider, log.model, log.promptTokens ?? 0, log.completionTokens ?? 0);
      totalUsd += cost;

      const uid = log.conversation.userId;
      byUser[uid] = (byUser[uid] ?? 0) + cost;
      byProvider[log.provider] = (byProvider[log.provider] ?? 0) + cost;

      const day = log.createdAt.toISOString().slice(0, 10);
      series[day] = (series[day] ?? 0) + cost;
    }

    return NextResponse.json({
      totalUsd,
      byProvider,
      byUser,
      series: Object.entries(series).map(([date, usd]) => ({ date, usd })),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
