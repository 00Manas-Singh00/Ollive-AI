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

function cosineSimilarity(a: number[], b: number[]): number {
  const magA = magnitude(a);
  const magB = magnitude(b);
  if (magA === 0 || magB === 0) return 0;
  return dotProduct(a, b) / (magA * magB);
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

  await prisma.knowledgeChunk.createMany({
    data: chunks.map((text, chunkIndex) => ({
      documentId: doc.id,
      chunkIndex,
      text,
      embedding: tfidfVector(text),
    })),
  });

  return doc.id;
}

export async function retrieveRelevantChunks(
  query: string,
  conversationId: string,
  topK = 3,
): Promise<string[]> {
  const chunks = await prisma.knowledgeChunk.findMany({
    where: { document: { conversationId } },
    select: { text: true, embedding: true },
  });

  if (chunks.length === 0) return [];

  const queryVec = tfidfVector(query);

  const scored = chunks.map((chunk) => ({
    text: chunk.text,
    score: Array.isArray(chunk.embedding)
      ? cosineSimilarity(queryVec, chunk.embedding as number[])
      : 0,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((c) => c.text);
}
