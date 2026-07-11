import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { requireRole } from "@/lib/rbac";
import { abortExperiment } from "@/lib/prompt-lab";

async function requireAdmin() {
  const user = await requireSessionUser();
  requireRole(user, "ADMIN");
  return user;
}

export async function POST(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await requireAdmin();
    const { id } = await params;

    const experiment = await prisma.promptExperiment.findUnique({ where: { id } });
    if (!experiment) return NextResponse.json({ error: "Experiment not found" }, { status: 404 });
    if (experiment.status !== "RUNNING") return NextResponse.json({ error: "Experiment is not running" }, { status: 409 });

    const updated = await abortExperiment(id);
    return NextResponse.json({ experiment: updated });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
