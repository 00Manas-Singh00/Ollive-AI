import { NextRequest, NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth";
import { requireRole } from "@/lib/rbac";
import { prisma } from "@/lib/prisma";
import { BudgetAction } from "@prisma/client";
import { z } from "zod";

const PatchSchema = z.object({
  monthlyBudgetUsd: z.number().positive().max(10000).nullable().optional(),
  budgetAction: z.nativeEnum(BudgetAction).optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    requireRole(user, "ADMIN");

    const { id } = await params;
    const body = await req.json();
    const patch = PatchSchema.parse(body);

    const updated = await prisma.user.update({
      where: { id },
      data: patch,
      select: { id: true, email: true, name: true, monthlyBudgetUsd: true, budgetAction: true },
    });

    return NextResponse.json(updated);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues }, { status: 400 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
