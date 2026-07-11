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
        AND: [
          { OR: [{ userId: user.id }, { members: { some: { userId: user.id } } }] },
          includeArchived ? {} : { isArchived: false },
          folder ? { folder } : {},
          tag ? { tags: { has: tag } } : {},
          q
            ? {
                OR: [
                  { title: { contains: q, mode: "insensitive" } },
                  { messages: { some: { content: { contains: q, mode: "insensitive" } } } },
                ],
              }
            : {},
        ],
      },
      orderBy: [{ isPinned: "desc" }, { updatedAt: "desc" }],
      include: {
        messages: {
          orderBy: { createdAt: "asc" },
          include: { raceResults: { orderBy: { createdAt: "asc" } }, reasoningTrace: true, widgetInteraction: true },
        },
        members: {
          include: { user: { select: { id: true, name: true, email: true } } },
        },
      },
    });
    const withRole = conversations.map((c) => ({
      ...c,
      myRole: c.userId === user.id ? "OWNER" : c.members.find((m) => m.userId === user.id)?.role ?? "VIEWER",
    }));
    return NextResponse.json({ conversations: withRole });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
