import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

const upsertSchema = z.object({
  rating: z.number().int().min(1).max(5).optional(),
  thumbs: z.enum(["up", "down"]).optional(),
  comment: z.string().max(2000).optional(),
});

type Params = { params: Promise<{ messageId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  try {
    const user = await requireSessionUser();
    const { messageId } = await params;
    const body = await req.json();
    const data = upsertSchema.parse(body);

    const annotation = await prisma.messageAnnotation.upsert({
      where: { messageId_userId: { messageId, userId: user.id } },
      create: { messageId, userId: user.id, ...data },
      update: data,
    });

    return NextResponse.json(annotation);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues }, { status: 400 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function GET(req: NextRequest, { params }: Params) {
  try {
    const user = await requireSessionUser();
    const { messageId } = await params;

    const isPrivileged = user.role === "ADMIN" || user.role === "ANALYST";

    const annotations = isPrivileged
      ? await prisma.messageAnnotation.findMany({ where: { messageId } })
      : await prisma.messageAnnotation.findMany({ where: { messageId, userId: user.id } });

    return NextResponse.json(annotations);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const user = await requireSessionUser();
    const { messageId } = await params;

    await prisma.messageAnnotation.delete({
      where: { messageId_userId: { messageId, userId: user.id } },
    });

    return NextResponse.json({ deleted: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
