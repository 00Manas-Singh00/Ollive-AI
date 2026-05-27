import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title.trim() : undefined;
    const folder = typeof body.folder === "string" ? body.folder.trim() : body.folder === null ? null : undefined;
    const tags = Array.isArray(body.tags) ? body.tags.map((tag: unknown) => (typeof tag === "string" ? tag.trim() : "")).filter(Boolean).slice(0, 20) : undefined;

    const existing = await prisma.conversation.findFirst({ where: { id, userId: user.id } });
    if (!existing) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

    const conversation = await prisma.conversation.update({
      where: { id },
      data: {
        ...(title !== undefined ? { title: title || "Untitled conversation" } : {}),
        ...(typeof body.isArchived === "boolean" ? { isArchived: body.isArchived } : {}),
        ...(typeof body.isPinned === "boolean" ? { isPinned: body.isPinned } : {}),
        ...(folder !== undefined ? { folder } : {}),
        ...(tags !== undefined ? { tags } : {}),
      },
    });

    return NextResponse.json({ conversation });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;
    const existing = await prisma.conversation.findFirst({ where: { id, userId: user.id } });
    if (!existing) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    await prisma.conversation.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
