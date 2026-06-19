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

    const decisions = await prisma.promptDecision.findMany({
      where: { createdAt: { gte: from, lte: to } },
      select: { profileKey: true, version: true, variant: true, model: true, conversationId: true },
    });

    // Aggregate by profileKey + variant
    const agg: Record<string, Record<string, { count: number }>> = {};
    for (const d of decisions) {
      if (!agg[d.profileKey]) agg[d.profileKey] = {};
      const key = d.variant;
      if (!agg[d.profileKey][key]) agg[d.profileKey][key] = { count: 0 };
      agg[d.profileKey][key].count++;
    }

    const results = Object.entries(agg).map(([profileKey, variants]) => ({
      profileKey,
      variants: Object.entries(variants).map(([variant, v]) => ({ variant, count: v.count })),
    }));

    return NextResponse.json({ results, total: decisions.length });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
