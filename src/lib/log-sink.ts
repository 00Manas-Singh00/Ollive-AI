import { createHash } from "crypto";
import { prisma } from "@/lib/prisma";
import { recordSpend } from "@/lib/budget";
import type { IngestPayload } from "@/lib/ingest-schema";

// TODO(T5): replaced by a real eventId generated at request start; this hash is a
// temporary idempotency key derived from payload content.
export function idempotencyKeyFromPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  return createHash("sha256").update(serialized).digest("hex");
}

// Writes an InferenceLog row directly against Postgres, bypassing BullMQ. Used when
// Redis is unavailable, or as the resilient fallback if the in-process enqueue fails.
// Mirrors src/workers/ingest-worker.ts's processing (idempotency + InferenceLog write
// + spend accounting) so logs never silently vanish just because there's no worker.
export async function writeLogDirect(eventId: string, payload: IngestPayload): Promise<void> {
  const existing = await prisma.ingestionEvent.findUnique({ where: { id: eventId } });
  if (existing?.status === "processed") return;

  if (!existing) {
    await prisma.ingestionEvent.create({
      data: { id: eventId, conversationId: payload.conversationId, status: "processing" },
    });
  }

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
    where: { id: eventId },
    create: { id: eventId, conversationId: payload.conversationId, status: "processed", processedAt: new Date() },
    update: { status: "processed", processedAt: new Date() },
  });
}
