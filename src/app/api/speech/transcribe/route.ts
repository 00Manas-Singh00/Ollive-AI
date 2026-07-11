import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { transcribeAudio } from "@/lib/speech";
import { sendLog, preview } from "@/lib/llm";

const MAX_AUDIO_BYTES = 10 * 1024 * 1024; // 10 MB

const metaSchema = z.object({ conversationId: z.string().min(1).optional() });

export async function POST(req: NextRequest) {
  const start = Date.now();
  const requestTs = new Date();
  try {
    const user = await requireSessionUser();

    const formData = await req.formData();
    const file = formData.get("audio");
    if (!(file instanceof File)) return NextResponse.json({ error: "audio field required" }, { status: 400 });

    const meta = metaSchema.safeParse({ conversationId: formData.get("conversationId")?.toString() || undefined });
    if (!meta.success) return NextResponse.json({ error: "Invalid metadata" }, { status: 400 });

    const bytes = await file.arrayBuffer();
    if (bytes.byteLength > MAX_AUDIO_BYTES) return NextResponse.json({ error: "Audio too large (max 10 MB)" }, { status: 413 });

    // Fire-and-forget telemetry only fires when the conversation is real and owned by
    // this user (a new voice turn often precedes conversation creation).
    let conversationId: string | undefined = meta.data.conversationId;
    if (conversationId) {
      const owned = await prisma.conversation.findFirst({ where: { id: conversationId, userId: user.id }, select: { id: true } });
      if (!owned) conversationId = undefined;
    }

    const result = await transcribeAudio(Buffer.from(bytes), file.type || "audio/webm", file.name || "recording.webm");

    if (conversationId) {
      void sendLog({
        conversationId,
        provider: `${result.provider}-stt`,
        model: result.model,
        status: "success",
        mode: "sync",
        latencyMs: Date.now() - start,
        requestTs: requestTs.toISOString(),
        responseTs: new Date().toISOString(),
        inputPreview: `[audio ${bytes.byteLength} bytes]`,
        outputPreview: preview(result.text),
      });
    }

    return NextResponse.json({ text: result.text });
  } catch (error) {
    if (error instanceof Error && error.message === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: error instanceof Error ? error.message : "Transcription failed" }, { status: 500 });
  }
}
