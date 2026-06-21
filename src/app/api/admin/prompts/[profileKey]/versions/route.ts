import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { z } from "zod";

async function requireAdmin() {
  const user = await requireSessionUser();
  if (!user.isAdmin) throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
  return user;
}

const CreateVersionSchema = z.object({
  basePrompt: z.string().min(1),
  variantA: z.string().optional(),
  variantB: z.string().optional(),
  abRatioA: z.number().int().min(0).max(100).optional(),
  modelOverrides: z.record(z.string()).optional(),
  isRollbackPoint: z.boolean().optional(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ profileKey: string }> }) {
  try {
    await requireAdmin();
    const { profileKey } = await params;
    const profile = await prisma.promptProfile.findUnique({ where: { key: profileKey } });
    if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

    const versions = await prisma.promptVersion.findMany({
      where: { profileId: profile.id },
      orderBy: { version: "desc" },
    });
    return NextResponse.json({ versions, activeVersion: profile.activeVersion });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ profileKey: string }> }) {
  try {
    await requireAdmin();
    const { profileKey } = await params;
    const body = await req.json();
    const data = CreateVersionSchema.parse(body);

    const profile = await prisma.promptProfile.findUnique({ where: { key: profileKey } });
    if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

    const latest = await prisma.promptVersion.findFirst({
      where: { profileId: profile.id },
      orderBy: { version: "desc" },
    });
    const nextVersion = (latest?.version ?? 0) + 1;

    const version = await prisma.promptVersion.create({
      data: {
        profileId: profile.id,
        version: nextVersion,
        basePrompt: data.basePrompt,
        variantA: data.variantA,
        variantB: data.variantB,
        abRatioA: data.abRatioA ?? 50,
        modelOverrides: data.modelOverrides ?? {},
        isRollbackPoint: data.isRollbackPoint ?? false,
      },
    });

    return NextResponse.json({ version }, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.errors }, { status: 400 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
