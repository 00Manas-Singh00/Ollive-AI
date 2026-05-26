import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { ingestQueue } from "@/lib/queue";
import { logSchema } from "@/lib/ingest-schema";

function idempotencyKeyFromPayload(payload: unknown): string {
  const serialized = JSON.stringify(payload);
  return createHash("sha256").update(serialized).digest("hex");
}

export async function POST(req: NextRequest) {
  try {
    const raw = await req.json();
    const payload = logSchema.parse(raw);
    const eventId = idempotencyKeyFromPayload(payload);

    await ingestQueue.add(
      "ingest-log",
      { eventId, payload },
      { jobId: eventId }
    );

    return NextResponse.json({ ok: true, eventId, queued: true }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "Invalid payload" },
      { status: 400 }
    );
  }
}
