import { prisma } from "@/lib/prisma";
import { recordSpend } from "@/lib/budget";
import type { IngestPayload } from "@/lib/ingest-schema";

// Writes an InferenceLog row directly against Postgres, bypassing BullMQ. Used when
// Redis is unavailable, or as the resilient fallback if the in-process enqueue fails.
// Mirrors src/workers/ingest-worker.ts's processing (idempotency + InferenceLog write
// + spend accounting) so logs never silently vanish just because there's no worker.
// Idempotent on payload.eventId (upsert) — safe to call twice for the same event.
export async function writeLogDirect(payload: IngestPayload): Promise<void> {
  const existing = await prisma.ingestionEvent.findUnique({ where: { id: payload.eventId } });
  if (existing?.status === "processed") return;

  if (!existing) {
    await prisma.ingestionEvent.create({
      data: { id: payload.eventId, conversationId: payload.conversationId, status: "processing" },
    });
  }

  await prisma.inferenceLog.upsert({
    where: { eventId: payload.eventId },
    create: {
      eventId: payload.eventId,
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
    update: {},
  });

  if (payload.status === "success" && ((payload.promptTokens ?? 0) > 0 || (payload.completionTokens ?? 0) > 0)) {
    const conversation = await prisma.conversation.findUnique({
      where: { id: payload.conversationId },
      select: { userId: true },
    });
    if (conversation) {
      await recordSpend(conversation.userId, payload.provider, payload.model, payload.promptTokens ?? 0, payload.completionTokens ?? 0);
    }
  }

  await prisma.ingestionEvent.upsert({
    where: { id: payload.eventId },
    create: { id: payload.eventId, conversationId: payload.conversationId, status: "processed", processedAt: new Date() },
    update: { status: "processed", processedAt: new Date() },
  });
}
