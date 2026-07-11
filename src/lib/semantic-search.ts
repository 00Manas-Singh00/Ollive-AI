import { prisma } from "@/lib/prisma";
import { embedText, cosineSimilarity, EMBEDDING_MODEL } from "@/lib/rag";

// Cap on vectors scanned per search until pgvector is adopted — cosine scoring
// happens in-process, so an unbounded scan would grow linearly with history.
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

export async function searchConversations(
  userId: string,
  query: string,
  limit = 10,
): Promise<ConversationSearchHit[]> {
  const queryVec = embedText(query);

  // Most recent messages first: keeps the scan bounded and biases toward the
  // conversations a user is most likely looking for.
  const rows = await prisma.messageEmbedding.findMany({
    where: {
      model: EMBEDDING_MODEL,
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

  return [...bestPerConversation.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
