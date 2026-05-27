import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST() {
  const key = process.env.PROMPT_PROFILE_KEY || "chat-default";
  const profile = await prisma.promptProfile.findUnique({ where: { key } });
  if (!profile) return NextResponse.json({ error: "Prompt profile not found" }, { status: 404 });

  const rollback = await prisma.promptVersion.findFirst({
    where: { profileId: profile.id, isRollbackPoint: true },
    orderBy: { version: "desc" },
  });
  if (!rollback) return NextResponse.json({ error: "No rollback point found" }, { status: 404 });

  const updated = await prisma.promptProfile.update({ where: { key }, data: { activeVersion: rollback.version } });
  return NextResponse.json({ profile: updated, rollbackVersion: rollback.version });
}
