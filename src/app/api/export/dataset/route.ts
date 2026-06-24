import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { requireRole } from "@/lib/rbac";

const BATCH_SIZE = 200;

function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

export async function GET(req: NextRequest) {
  try {
    const user = await requireSessionUser();
    requireRole(user, "ANALYST");

    const { searchParams } = new URL(req.url);
    const format = (searchParams.get("format") || "jsonl").toLowerCase();
    const minScore = searchParams.get("minScore") ? Number(searchParams.get("minScore")) : undefined;
    const from = searchParams.get("from") ? new Date(searchParams.get("from")!) : undefined;
    const to = searchParams.get("to") ? new Date(searchParams.get("to")!) : undefined;

    if (format !== "jsonl" && format !== "csv") {
      return NextResponse.json({ error: "format must be jsonl or csv" }, { status: 400 });
    }

    const { readable, writable } = new TransformStream<string, Uint8Array>({
      transform(chunk, controller) {
        controller.enqueue(new TextEncoder().encode(chunk));
      },
    });
    const writer = writable.getWriter();

    (async () => {
      try {
        let cursor: string | undefined;
        let wroteHeader = false;

        while (true) {
          const scores = await prisma.qualityScore.findMany({
            where: {
              ...(minScore !== undefined ? { score: { gte: minScore } } : {}),
              ...(from || to ? { createdAt: { gte: from, lte: to } } : {}),
            },
            include: { message: { include: { conversation: true } } },
            orderBy: { id: "asc" },
            take: BATCH_SIZE,
            ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
          });

          if (scores.length === 0) break;

          for (const qs of scores) {
            const assistantMessage = qs.message;
            const userMessage = await prisma.chatMessage.findFirst({
              where: { conversationId: assistantMessage.conversationId, role: "user", createdAt: { lt: assistantMessage.createdAt } },
              orderBy: { createdAt: "desc" },
            });

            const row = {
              conversationId: assistantMessage.conversationId,
              messageId: assistantMessage.id,
              prompt: userMessage?.content ?? "",
              completion: assistantMessage.content,
              qualityScore: qs.score,
              breakdown: qs.breakdown,
              createdAt: assistantMessage.createdAt.toISOString(),
            };

            if (format === "jsonl") {
              await writer.write(`${JSON.stringify(row)}\n`);
            } else {
              if (!wroteHeader) {
                await writer.write("conversationId,messageId,prompt,completion,qualityScore,createdAt\n");
                wroteHeader = true;
              }
              await writer.write(
                `${csvEscape(row.conversationId)},${csvEscape(row.messageId)},${csvEscape(row.prompt)},${csvEscape(row.completion)},${row.qualityScore},${row.createdAt}\n`
              );
            }
          }

          cursor = scores[scores.length - 1].id;
          if (scores.length < BATCH_SIZE) break;
        }
      } catch (err) {
        console.error("[export/dataset] stream failed:", err);
      } finally {
        await writer.close();
      }
    })();

    return new Response(readable, {
      headers: {
        "Content-Type": format === "jsonl" ? "application/x-ndjson" : "text/csv",
        "Content-Disposition": `attachment; filename="dataset.${format === "jsonl" ? "jsonl" : "csv"}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
