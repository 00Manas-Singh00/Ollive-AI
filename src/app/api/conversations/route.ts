import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";

export async function GET(req: Request) {
  try {
    const user = await requireSessionUser();
    const { searchParams } = new URL(req.url);
    const q = (searchParams.get("q") || "").trim();
    const includeArchived = searchParams.get("includeArchived") === "true";
    const folder = (searchParams.get("folder") || "").trim();
    const tag = (searchParams.get("tag") || "").trim();

    const conversations = await prisma.conversation.findMany({
      where: {
        userId: user.id,
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
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          include: { raceResults: { orderBy: { createdAt: "asc" } }, reasoningTrace: true, widgetInteraction: true },
        },
      },
    });
    return NextResponse.json({ conversations });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
