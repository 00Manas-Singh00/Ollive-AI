import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { ingestDocument } from "@/lib/rag";
import { z } from "zod";

const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id: conversationId } = await params;

    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId: user.id } });
    if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

    const formData = await req.formData();
    const file = formData.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "file field required" }, { status: 400 });

    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_FILE_BYTES) return NextResponse.json({ error: "File too large (max 2 MB)" }, { status: 413 });

    const content = new TextDecoder().decode(bytes);
    const documentId = await ingestDocument(content, file.name, user.id, conversationId);

    return NextResponse.json({ documentId }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id: conversationId } = await params;

    const conversation = await prisma.conversation.findFirst({ where: { id: conversationId, userId: user.id } });
    if (!conversation) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });

    const documents = await prisma.knowledgeDocument.findMany({
      where: { conversationId },
      select: { id: true, filename: true, createdAt: true, _count: { select: { chunks: true } } },
      orderBy: { createdAt: "desc" },
    });

    return NextResponse.json({ documents });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
