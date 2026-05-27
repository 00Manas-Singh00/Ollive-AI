import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET() {
  const key = process.env.PROMPT_PROFILE_KEY || "chat-default";
  const profile = await prisma.promptProfile.findUnique({ where: { key }, include: { versions: { orderBy: { version: "desc" } } } });
  return NextResponse.json({ profile });
}

export async function POST(req: NextRequest) {
  const key = process.env.PROMPT_PROFILE_KEY || "chat-default";
  const body = await req.json().catch(() => ({}));
  const activeVersion = Number(body?.activeVersion);
  if (!Number.isInteger(activeVersion) || activeVersion < 1) return NextResponse.json({ error: "activeVersion must be a positive integer" }, { status: 400 });

  const profile = await prisma.promptProfile.findUnique({ where: { key } });
  if (!profile) return NextResponse.json({ error: "Prompt profile not found" }, { status: 404 });

  const exists = await prisma.promptVersion.findFirst({ where: { profileId: profile.id, version: activeVersion } });
  if (!exists) return NextResponse.json({ error: "Prompt version does not exist" }, { status: 404 });

  const updated = await prisma.promptProfile.update({ where: { key }, data: { activeVersion } });
  return NextResponse.json({ profile: updated });
}
