import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateWidgetResponse } from "@/lib/generative-ui";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { assertConversationAccess, collabErrorResponse } from "@/lib/collab";

type Params = { params: Promise<{ messageId: string }> };

const PatchSchema = z.object({ userResponse: z.unknown() });

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const user = await requireSessionUser();
    const { messageId } = await params;

    const message = await prisma.chatMessage.findUnique({
      where: { id: messageId },
      select: { conversationId: true, widgetInteraction: true },
    });
    if (!message?.widgetInteraction) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await assertConversationAccess(user, message.conversationId, "COLLABORATOR");

    const body = PatchSchema.safeParse(await req.json());
    if (!body.success) return NextResponse.json({ error: "userResponse is required" }, { status: 400 });

    const validated = validateWidgetResponse(message.widgetInteraction.widgetType, body.data.userResponse);
    if (!validated.ok) return NextResponse.json({ error: validated.error }, { status: 400 });

    const updated = await prisma.widgetInteraction.update({
      where: { messageId },
      data: { userResponse: validated.data },
    });

    return NextResponse.json(updated);
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    const msg = error instanceof Error ? error.message : "Error";
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
