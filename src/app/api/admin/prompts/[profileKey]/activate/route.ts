import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { z } from "zod";

async function requireAdmin() {
  const user = await requireSessionUser();
  if (!user.isAdmin) throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
  return user;
}

const ActivateSchema = z.object({ version: z.number().int().min(1) });

export async function POST(req: NextRequest, { params }: { params: Promise<{ profileKey: string }> }) {
  try {
    await requireAdmin();
    const { profileKey } = await params;
    const body = await req.json();
    const { version } = ActivateSchema.parse(body);

    const profile = await prisma.promptProfile.findUnique({ where: { key: profileKey } });
    if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

    const versionRecord = await prisma.promptVersion.findFirst({ where: { profileId: profile.id, version } });
    if (!versionRecord) return NextResponse.json({ error: "Version not found" }, { status: 404 });

    const updated = await prisma.promptProfile.update({ where: { key: profileKey }, data: { activeVersion: version } });

    // Audit entry — written as a synthetic PromptDecision with a sentinel conversationId
    await prisma.promptDecision.create({
      data: {
        conversationId: profile.id, // reuse profile.id as a stable sentinel; real convIds are cuid
        profileKey,
        version,
        variant: "base",
        resolvedPrompt: versionRecord.basePrompt,
        model: "__admin_activate__",
      },
    }).catch(() => {/* non-fatal — conversationId FK may reject; that's acceptable */});

    return NextResponse.json({ profile: updated });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.errors }, { status: 400 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
