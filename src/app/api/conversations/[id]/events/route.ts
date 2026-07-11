import { NextRequest } from "next/server";
import { requireSessionUser } from "@/lib/auth";
import { assertConversationAccess, collabErrorResponse, conversationChannel, createSubscriberConnection } from "@/lib/collab";

// Long-lived SSE subscription mirroring Redis pub/sub for a collaborative
// conversation: message_created, token, thought, presence, annotation_updated.
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let user;
  try {
    user = await requireSessionUser();
    const { id } = await params;
    await assertConversationAccess(user, id, "VIEWER");

    const subscriber = createSubscriberConnection();
    const encoder = new TextEncoder();
    let eventId = 0;

    const stream = new ReadableStream({
      async start(controller) {
        const send = (data: string, event?: string) => {
          eventId += 1;
          let frame = `id: ${eventId}\n`;
          if (event) frame += `event: ${event}\n`;
          frame += `data: ${data}\n\n`;
          controller.enqueue(encoder.encode(frame));
        };

        await subscriber.subscribe(conversationChannel(id));
        subscriber.on("message", (_channel, message) => {
          send(message);
        });

        // Heartbeat presence every 20s so peers can render live avatars.
        send(JSON.stringify({ type: "presence", userId: user!.id, name: user!.name }));
        const heartbeat = setInterval(() => {
          send(JSON.stringify({ type: "presence", userId: user!.id, name: user!.name }));
        }, 20000);

        const cleanup = () => {
          clearInterval(heartbeat);
          void subscriber.quit();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };

        req.signal.addEventListener("abort", cleanup);
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    const known = collabErrorResponse(error);
    if (known) return known;
    return new Response(JSON.stringify({ error: error instanceof Error ? error.message : "Failed" }), { status: 500 });
  }
}
