import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { validateWidgetResponse } from "@/lib/generative-ui";
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";

type Params = { params: Promise<{ messageId: string }> };

const PatchSchema = z.object({ userResponse: z.unknown() });

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const user = await requireSessionUser();
    const { messageId } = await params;

    // Ownership check: the message must belong to a conversation owned by the user.
    const message = await prisma.chatMessage.findFirst({
      where: { id: messageId, conversation: { userId: user.id } },
      select: { id: true, widgetInteraction: true },
    });
    if (!message?.widgetInteraction) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
