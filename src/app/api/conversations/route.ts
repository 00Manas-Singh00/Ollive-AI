import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const includeArchived = searchParams.get("includeArchived") === "true";
    const folder = (searchParams.get("folder") || "").trim();
    const tag = (searchParams.get("tag") || "").trim();

    const conversations = await prisma.conversation.findMany({
      where: {
        ...(includeArchived ? {} : { isArchived: false }),
        ...(folder ? { folder } : {}),
        ...(tag ? { tags: { has: tag } } : {}),
        ...(q
          ? {
              OR: [
                { title: { contains: q, mode: "insensitive" } },
                { messages: { some: { content: { contains: q, mode: "insensitive" } } } },
              ],
            }
          : {}),
      },
      orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
      include: { messages: { orderBy: { createdAt: "asc" } } },
    });
    return NextResponse.json({ conversations });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to fetch conversations" },
      { status: 500 }
    );
  }
}
