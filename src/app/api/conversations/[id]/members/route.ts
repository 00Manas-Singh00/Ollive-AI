import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { assertConversationAccess, collabErrorResponse } from "@/lib/collab";

const InviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["COLLABORATOR", "VIEWER"]).default("COLLABORATOR"),
});

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;
    await assertConversationAccess(user, id, "VIEWER");

    const members = await prisma.conversationMember.findMany({
      where: { conversationId: id },
      include: { user: { select: { id: true, name: true, email: true } } },
      orderBy: { createdAt: "asc" },
    });
    return NextResponse.json({ members });
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;
    // Inviting collaborators is an owner-only action.
    await assertConversationAccess(user, id, "OWNER");

    const body = InviteSchema.parse(await req.json());
    const invitee = await prisma.user.findUnique({ where: { email: body.email } });
    if (!invitee) return NextResponse.json({ error: "No user found with that email" }, { status: 404 });

    const conversation = await prisma.conversation.findUnique({ where: { id }, select: { userId: true } });
    if (conversation?.userId === invitee.id) {
      return NextResponse.json({ error: "That user already owns this conversation" }, { status: 400 });
    }

    const [member] = await prisma.$transaction([
      prisma.conversationMember.upsert({
        where: { conversationId_userId: { conversationId: id, userId: invitee.id } },
        create: { conversationId: id, userId: invitee.id, role: body.role },
        update: { role: body.role },
        include: { user: { select: { id: true, name: true, email: true } } },
      }),
      prisma.conversation.update({ where: { id }, data: { isCollaborative: true } }),
    ]);

    return NextResponse.json({ member });
  } catch (error) {
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues }, { status: 400 });
    const known = collabErrorResponse(error);
    if (known) return known;
    return NextResponse.json({ error: error instanceof Error ? error.message : "Failed" }, { status: 500 });
  }
}
