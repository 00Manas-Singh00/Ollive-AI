import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";

async function requireAdmin() {
  const user = await requireSessionUser();
  if (!user.isAdmin) throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
  return user;
}

export async function POST(_req: Request, { params }: { params: Promise<{ profileKey: string }> }) {
  try {
    await requireAdmin();
    const { profileKey } = await params;

    const profile = await prisma.promptProfile.findUnique({ where: { key: profileKey } });
    if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

    const rollback = await prisma.promptVersion.findFirst({
      where: { profileId: profile.id, isRollbackPoint: true },
      orderBy: { version: "desc" },
    });
    if (!rollback) return NextResponse.json({ error: "No rollback point found" }, { status: 404 });

    const updated = await prisma.promptProfile.update({ where: { key: profileKey }, data: { activeVersion: rollback.version } });
    return NextResponse.json({ profile: updated, rollbackVersion: rollback.version });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
