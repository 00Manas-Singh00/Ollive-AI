import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { synthesizeSpeech } from "@/lib/speech";
import { sendLog, preview } from "@/lib/llm";

const bodySchema = z.object({
  text: z.string().min(1).max(4000),
  conversationId: z.string().min(1).optional(),
});

export async function POST(req: NextRequest) {
  const start = Date.now();
  const requestTs = new Date();
  try {
    const user = await requireSessionUser();
    const parsed = bodySchema.safeParse(await req.json());
    if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

    let conversationId: string | undefined = parsed.data.conversationId;
    if (conversationId) {
      const owned = await prisma.conversation.findFirst({ where: { id: conversationId, userId: user.id }, select: { id: true } });
      if (!owned) conversationId = undefined;
    }

    const result = await synthesizeSpeech(parsed.data.text);

    if (conversationId) {
      void sendLog({
        conversationId,
        provider: `${result.provider}-tts`,
        model: result.model,
        status: "success",
        mode: "sync",
        latencyMs: Date.now() - start,
        requestTs: requestTs.toISOString(),
        responseTs: new Date().toISOString(),
        inputPreview: preview(parsed.data.text),
        outputPreview: `[audio ${result.audio.byteLength} bytes]`,
      });
    }

    return new NextResponse(new Uint8Array(result.audio), {
      status: 200,
      headers: { "Content-Type": result.mimeType, "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Synthesis failed" }, { status: 500 });
  }
}
