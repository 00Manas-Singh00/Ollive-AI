import { prisma } from "@/lib/prisma";
import { embedText, cosineSimilarity } from "@/lib/rag";

// Cap on vectors scanned per search when falling back to the hash-vector path —
// cosine scoring happens in-process there, so an unbounded scan would grow linearly
// with history. The pgvector path (used whenever a real embedding is available)
// scores in SQL and isn't subject to this cap.
const MAX_VECTORS_SCANNED = Math.max(
  100,
  Number(process.env.SEARCH_MAX_VECTORS ?? 5000) || 5000,
);

const SNIPPET_LENGTH = 160;

export type ConversationSearchHit = {
  conversationId: string;
  title: string;
  snippet: string;
  score: number;
  messageId: string;
};

function toSnippet(content: string): string {
  const flat = content.replace(/\s+/g, " ").trim();
  return flat.length <= SNIPPET_LENGTH ? flat : `${flat.slice(0, SNIPPET_LENGTH)}…`;
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

type VectorRow = { conversationId: string; title: string; content: string; messageId: string; score: number };

async function searchViaVector(userId: string, queryVector: number[], limit: number): Promise<ConversationSearchHit[] | null> {
  const rows = await prisma.$queryRawUnsafe<VectorRow[]>(
    `SELECT DISTINCT ON (c.id) c.id AS "conversationId", c.title, cm.content, cm.id AS "messageId",
            1 - (me."embeddingVector" <=> $1::vector) AS score
     FROM "MessageEmbedding" me
     JOIN "ChatMessage" cm ON me."messageId" = cm.id
     JOIN "Conversation" c ON cm."conversationId" = c.id
     WHERE c."userId" = $2 AND me."embeddingVector" IS NOT NULL
     ORDER BY c.id, me."embeddingVector" <=> $1::vector
     LIMIT $3`,
    toVectorLiteral(queryVector),
    userId,
    limit,
  );
  if (rows.length === 0) return null;
  return rows
    .map((r) => ({ conversationId: r.conversationId, title: r.title, snippet: toSnippet(r.content), score: r.score, messageId: r.messageId }))
    .sort((a, b) => b.score - a.score);
}

async function searchViaHashScan(userId: string, query: string, limit: number): Promise<ConversationSearchHit[]> {
  const queryVec = (await embedText(query)).vector;

  // Most recent messages first: keeps the scan bounded and biases toward the
  // conversations a user is most likely looking for.
  const rows = await prisma.messageEmbedding.findMany({
    where: {
      message: { conversation: { userId } },
    },
    orderBy: { message: { createdAt: "desc" } },
    take: MAX_VECTORS_SCANNED,
    select: {
      vector: true,
      message: {
        select: {
          id: true,
          content: true,
          conversation: { select: { id: true, title: true } },
        },
      },
    },
  });

  const bestPerConversation = new Map<string, ConversationSearchHit>();

  for (const row of rows) {
    if (!Array.isArray(row.vector)) continue;
    const score = cosineSimilarity(queryVec, row.vector as number[]);
    if (score <= 0) continue;

    const conv = row.message.conversation;
    const existing = bestPerConversation.get(conv.id);
    if (!existing || score > existing.score) {
      bestPerConversation.set(conv.id, {
        conversationId: conv.id,
        title: conv.title,
        snippet: toSnippet(row.message.content),
        score,
        messageId: row.message.id,
      });
    }
  }

  return [...bestPerConversation.values()].sort((a, b) => b.score - a.score).slice(0, limit);
}

export async function searchConversations(
  userId: string,
  query: string,
  limit = 10,
): Promise<ConversationSearchHit[]> {
  const { realVector } = await embedText(query);
  const vectorHits = realVector ? await searchViaVector(userId, realVector, limit) : null;
  return vectorHits ?? searchViaHashScan(userId, query, limit);
}
