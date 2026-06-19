import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const user = await requireSessionUser();
    if (!user.isAdmin) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { searchParams } = req.nextUrl;
    const from = searchParams.get("from") ? new Date(searchParams.get("from")!) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const to = searchParams.get("to") ? new Date(searchParams.get("to")!) : new Date();
    const provider = searchParams.get("provider") ?? undefined;
    const groupBy = searchParams.get("groupBy") ?? "day";

    const where = {
      createdAt: { gte: from, lte: to },
      ...(provider ? { provider } : {}),
    };

    const logs = await prisma.inferenceLog.findMany({
      where,
      select: {
        provider: true,
        model: true,
        status: true,
        latencyMs: true,
        promptTokens: true,
        completionTokens: true,
        totalTokens: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
    });

    // Group by time bucket
    const buckets: Record<string, { count: number; errors: number; totalLatency: number; tokens: number }> = {};
    for (const log of logs) {
      const d = log.createdAt;
      let key: string;
      if (groupBy === "hour") {
        key = `${d.toISOString().slice(0, 13)}:00`;
      } else if (groupBy === "week") {
        const week = new Date(d);
        week.setDate(week.getDate() - week.getDay());
        key = week.toISOString().slice(0, 10);
      } else {
        key = d.toISOString().slice(0, 10);
      }
      if (!buckets[key]) buckets[key] = { count: 0, errors: 0, totalLatency: 0, tokens: 0 };
      buckets[key].count++;
      if (log.status === "error") buckets[key].errors++;
      buckets[key].totalLatency += log.latencyMs;
      buckets[key].tokens += log.totalTokens ?? 0;
    }

    const series = Object.entries(buckets).map(([date, v]) => ({
      date,
      count: v.count,
      errors: v.errors,
      avgLatencyMs: v.count > 0 ? Math.round(v.totalLatency / v.count) : 0,
      tokens: v.tokens,
    }));

    const byProvider: Record<string, number> = {};
    for (const log of logs) {
      byProvider[log.provider] = (byProvider[log.provider] ?? 0) + 1;
    }

    return NextResponse.json({ series, byProvider, total: logs.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
