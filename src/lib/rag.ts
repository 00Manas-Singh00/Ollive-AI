import { prisma } from "@/lib/prisma";

// Split text into ~500-token chunks by paragraph boundaries
function chunkText(text: string): string[] {
  const CHUNK_TARGET = 500; // approximate tokens (chars / 4)
  const TARGET_CHARS = CHUNK_TARGET * 4;

  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (!para.trim()) continue;
    if (current.length + para.length > TARGET_CHARS && current.length > 0) {
      chunks.push(current.trim());
      current = para;
    } else {
      current = current ? `${current}\n\n${para}` : para;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// Fixed-width term-frequency vector, hashed into HASH_DIM buckets so vectors
// computed at ingest time and at query time always share the same dimensions
// (a per-call vocabulary would assign different indices to the same term).
const HASH_DIM = 512;

// Dimension of real embedding vectors — must match the pgvector column width
// (see prisma/migrations/..._phase_t9_pgvector) and the configured EMBEDDING_MODEL's
// actual output dimension (e.g. nomic-embed-text=768, bge-m3=1024 — set EMBEDDING_DIM
// to match if you swap models).
const EMBEDDING_DIM = Math.max(1, Number(process.env.EMBEDDING_DIM ?? 768) || 768);

// Identifies the fallback scheme on persisted hash vectors. Renamed from the
// misleading "tfidf-hash-512" — this is plain hashed term-frequency, no IDF term.
export const HASH_FALLBACK_MODEL = "hash-tf-512";

function hashTerm(term: string): number {
  let h = 0;
  for (let i = 0; i < term.length; i++) h = (h * 31 + term.charCodeAt(i)) >>> 0;
  return h % HASH_DIM;
}

function tfidfVector(text: string): number[] {
  const tokens = tokenize(text);
  const vec = new Array<number>(HASH_DIM).fill(0);
  if (tokens.length === 0) return vec;
  for (const t of tokens) vec[hashTerm(t)] += 1 / tokens.length;
  return vec;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2);
}

function dotProduct(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

function magnitude(v: number[]): number {
  return Math.sqrt(v.reduce((s, x) => s + x * x, 0));
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dotProduct(a, b) / (magA * magB);
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

// Calls {EMBEDDING_BASE_URL||LLM_BASE_URL}/embeddings (OpenAI-compatible format) with
// EMBEDDING_MODEL. Returns null (never throws) on missing config, network failure, or a
// dimension mismatch against EMBEDDING_DIM — callers fall back to the hash vector.
async function realEmbedding(text: string): Promise<number[] | null> {
  const baseURL = process.env.EMBEDDING_BASE_URL || process.env.LLM_BASE_URL;
  const model = process.env.EMBEDDING_MODEL;
  if (!baseURL || !model) return null;

  try {
    const res = await fetch(`${baseURL.replace(/\/$/, "")}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(process.env.LLM_API_KEY ? { Authorization: `Bearer ${process.env.LLM_API_KEY}` } : {}),
      },
      body: JSON.stringify({ model, input: text }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = await res.json();
    const vec = data?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length !== EMBEDDING_DIM) return null;
    return vec as number[];
  } catch {
    return null;
  }
}

export type EmbedResult = { vector: number[]; model: string; realVector: number[] | null };

// Embeds text with the real embedding endpoint when configured; always also computes the
// hash-TF fallback vector so JSON-based scan/search paths keep working even for rows that
// have a real vector (and for deployments with no embedding endpoint at all).
export async function embedText(text: string): Promise<EmbedResult> {
  const real = await realEmbedding(text);
  return {
    vector: tfidfVector(text),
    model: real ? process.env.EMBEDDING_MODEL! : HASH_FALLBACK_MODEL,
    realVector: real,
  };
}

export async function ingestDocument(
  content: string,
  filename: string,
  userId: string,
  conversationId?: string,
): Promise<string> {
  const doc = await prisma.knowledgeDocument.create({
    data: { filename, content, userId, conversationId: conversationId ?? null },
  });

  const chunks = chunkText(content);
  const embedded = await Promise.all(chunks.map(async (text, chunkIndex) => ({ chunkIndex, text, ...(await embedText(text)) })));

  const created = await prisma.$transaction(
    embedded.map((c) =>
      prisma.knowledgeChunk.create({
        data: { documentId: doc.id, chunkIndex: c.chunkIndex, text: c.text, embedding: c.vector },
        select: { id: true },
      }),
    ),
  );

  await Promise.all(
    embedded.map((c, i) =>
      c.realVector
        ? prisma.$executeRawUnsafe(
            `UPDATE "KnowledgeChunk" SET "embeddingVector" = $1::vector WHERE id = $2`,
            toVectorLiteral(c.realVector),
            created[i].id,
          )
        : Promise.resolve(),
    ),
  );

  return doc.id;
}

export type RetrievedChunk = {
  id: string;
  text: string;
  score: number;
  excerptStart: number;
  excerptEnd: number;
};

// Pick the sentence within the chunk with the highest query-term overlap and
// return its [start, end) char offsets, so the UI can highlight the precise
// excerpt that justified the citation rather than the whole chunk.
function bestExcerpt(chunkText: string, queryTokens: Set<string>): { start: number; end: number } {
  if (queryTokens.size === 0) return { start: 0, end: chunkText.length };

  const sentenceRegex = /[^.!?\n]+[.!?]?/g;
  let best = { start: 0, end: chunkText.length, score: -1 };
  let match: RegExpExecArray | null;
  while ((match = sentenceRegex.exec(chunkText)) !== null) {
    const sentence = match[0];
    if (!sentence.trim()) continue;
    const overlap = tokenize(sentence).reduce((n, t) => n + (queryTokens.has(t) ? 1 : 0), 0);
    if (overlap > best.score) {
      best = { start: match.index, end: match.index + sentence.length, score: overlap };
    }
  }

  if (best.score <= 0) return { start: 0, end: chunkText.length };
  return { start: best.start, end: best.end };
}

async function retrieveViaVectorSearch(
  queryVector: number[],
  conversationId: string,
  topK: number,
): Promise<Array<{ id: string; text: string; score: number }> | null> {
  const rows = await prisma.$queryRawUnsafe<Array<{ id: string; text: string; score: number }>>(
    `SELECT kc.id, kc.text, 1 - (kc."embeddingVector" <=> $1::vector) AS score
     FROM "KnowledgeChunk" kc
     JOIN "KnowledgeDocument" kd ON kc."documentId" = kd.id
     WHERE kd."conversationId" = $2 AND kc."embeddingVector" IS NOT NULL
     ORDER BY kc."embeddingVector" <=> $1::vector
     LIMIT $3`,
    toVectorLiteral(queryVector),
    conversationId,
    topK,
  );
  return rows.length > 0 ? rows : null;
}

async function retrieveViaHashScan(
  query: string,
  conversationId: string,
  topK: number,
): Promise<Array<{ id: string; text: string; score: number }>> {
  const chunks = await prisma.knowledgeChunk.findMany({
    where: { document: { conversationId } },
    select: { id: true, text: true, embedding: true },
  });
  if (chunks.length === 0) return [];

  const queryVec = tfidfVector(query);
  const scored = chunks.map((chunk) => ({
    id: chunk.id,
    text: chunk.text,
    score: Array.isArray(chunk.embedding) ? cosineSimilarity(queryVec, chunk.embedding as number[]) : 0,
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

export async function retrieveRelevantChunks(
  query: string,
  conversationId: string,
  topK = 3,
): Promise<RetrievedChunk[]> {
  const { realVector } = await embedText(query);
  const queryTokens = new Set(tokenize(query));

  const vectorHits = realVector ? await retrieveViaVectorSearch(realVector, conversationId, topK) : null;
  const scored = vectorHits ?? (await retrieveViaHashScan(query, conversationId, topK));

  return scored.map((c) => {
    const { start, end } = bestExcerpt(c.text, queryTokens);
    return { id: c.id, text: c.text, score: c.score, excerptStart: start, excerptEnd: end };
  });
}

// Persist one MessageCitation per chunk that was actually injected into the
// prompt for this assistant turn. Skips chunks with no positive relevance so
// only genuinely-cited sources are recorded.
export async function persistCitations(messageId: string, chunks: RetrievedChunk[]): Promise<void> {
  const cited = chunks.filter((c) => c.score > 0);
  if (cited.length === 0) return;

  await prisma.messageCitation.createMany({
    data: cited.map((c) => ({
      messageId,
      chunkId: c.id,
      relevanceScore: c.score,
      excerptStart: c.excerptStart,
      excerptEnd: c.excerptEnd,
    })),
  });
}
