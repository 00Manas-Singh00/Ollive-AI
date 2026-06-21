import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { z } from "zod";

async function requireAdmin() {
  const user = await requireSessionUser();
  if (!user.isAdmin) throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
  return user;
}

const CreateProfileSchema = z.object({
  key: z.string().min(1).regex(/^[a-z0-9-]+$/),
  description: z.string().optional(),
  basePrompt: z.string().min(1),
  variantA: z.string().optional(),
  variantB: z.string().optional(),
  abRatioA: z.number().int().min(0).max(100).optional(),
  modelOverrides: z.record(z.string()).optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    const profiles = await prisma.promptProfile.findMany({
      include: { versions: { orderBy: { version: "desc" } } },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ profiles });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json();
    const data = CreateProfileSchema.parse(body);

    const existing = await prisma.promptProfile.findUnique({ where: { key: data.key } });
    if (existing) return NextResponse.json({ error: "Profile key already exists" }, { status: 409 });

    const profile = await prisma.promptProfile.create({
      data: {
        key: data.key,
        description: data.description,
        activeVersion: 1,
        versions: {
          create: {
            version: 1,
            basePrompt: data.basePrompt,
            variantA: data.variantA,
            variantB: data.variantB,
            abRatioA: data.abRatioA ?? 50,
            modelOverrides: data.modelOverrides ?? {},
            isRollbackPoint: true,
          },
        },
      },
      include: { versions: true },
    });

    return NextResponse.json({ profile }, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.errors }, { status: 400 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
