import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";

const logSchema = z.object({
  conversationId: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  status: z.enum(["success", "error"]),
  mode: z.enum(["sync", "stream"]).optional(),
  latencyMs: z.number().int().nonnegative(),
  ttftMs: z.number().int().nonnegative().optional(),
  streamDurationMs: z.number().int().nonnegative().optional(),
  promptTokens: z.number().int().nonnegative().optional(),
  completionTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
  requestTs: z.string().datetime(),
  responseTs: z.string().datetime(),
  inputPreview: z.string().min(1),
  outputPreview: z.string().optional(),
  errorMessage: z.string().optional(),
});

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const payload = logSchema.parse(raw);

    await prisma.inferenceLog.create({
      data: {
        conversationId: payload.conversationId,
        provider: payload.provider,
        model: payload.model,
        status: payload.status,
        mode: payload.mode,
        latencyMs: payload.latencyMs,
        ttftMs: payload.ttftMs,
        streamDurationMs: payload.streamDurationMs,
        promptTokens: payload.promptTokens,
        completionTokens: payload.completionTokens,
        totalTokens: payload.totalTokens,
        requestTs: new Date(payload.requestTs),
        responseTs: new Date(payload.responseTs),
        inputPreview: payload.inputPreview,
        outputPreview: payload.outputPreview,
        errorMessage: payload.errorMessage,
      },
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid payload" },
      { status: 400 }
    );
  }
}
