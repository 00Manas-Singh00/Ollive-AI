import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const title = typeof body.title === "string" ? body.title.trim() : undefined;
    const folder = typeof body.folder === "string" ? body.folder.trim() : body.folder === null ? null : undefined;
    const tags = Array.isArray(body.tags)
      ? body.tags
          .map((tag: unknown) => (typeof tag === "string" ? tag.trim() : ""))
          .filter(Boolean)
          .slice(0, 20)
      : undefined;

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
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to update conversation" },
      { status: 500 }
    );
  }
}

export async function DELETE(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    await prisma.conversation.delete({
      where: { id },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to delete conversation" },
      { status: 500 }
    );
  }
}
