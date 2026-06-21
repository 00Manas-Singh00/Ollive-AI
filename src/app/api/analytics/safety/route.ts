import { requireSessionUser } from "@/lib/auth";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  try {
    const user = await requireSessionUser();
    requireRole(user, "ANALYST");

    const { searchParams } = req.nextUrl;
    const from = searchParams.get("from") ? new Date(searchParams.get("from")!) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const to = searchParams.get("to") ? new Date(searchParams.get("to")!) : new Date();

    const logs = await prisma.safetyAuditLog.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: { phase: true, action: true, reason: true, categories: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });

    const byAction: Record<string, number> = {};
    const byPhase: Record<string, number> = {};
    const byCategory: Record<string, number> = {};
    for (const log of logs) {
      byAction[log.action] = (byAction[log.action] ?? 0) + 1;
      byPhase[log.phase] = (byPhase[log.phase] ?? 0) + 1;
      for (const cat of log.categories) {
        byCategory[cat] = (byCategory[cat] ?? 0) + 1;
      }
    }

    const series: Record<string, { blocked: number; allowed: number }> = {};
    for (const log of logs) {
      const key = log.createdAt.toISOString().slice(0, 10);
      if (!series[key]) series[key] = { blocked: 0, allowed: 0 };
      if (log.action === "blocked") series[key].blocked++;
      else series[key].allowed++;
    }

    return NextResponse.json({
      total: logs.length,
      byAction,
      byPhase,
      byCategory,
      series: Object.entries(series).map(([date, v]) => ({ date, ...v })),
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
