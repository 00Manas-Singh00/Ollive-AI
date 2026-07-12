import { NextRequest, NextResponse } from "next/server";
import { getIngestQueue } from "@/lib/queue";
import { logSchema } from "@/lib/ingest-schema";

// This route is for external log producers only — the app's own sendLog() enqueues
// in-process (see src/lib/llm.ts) and never calls it.
export async function POST(req: NextRequest) {
  const expectedToken = process.env.INGEST_TOKEN;
  if (!expectedToken) {
    return NextResponse.json({ ok: false, error: "Ingest endpoint is not configured" }, { status: 503 });
  }
  if (req.headers.get("x-ingest-token") !== expectedToken) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }

  try {
    const raw = await req.json();
    const payload = logSchema.parse(raw);
    const eventId = payload.eventId;
    const ingestQueue = getIngestQueue();

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
