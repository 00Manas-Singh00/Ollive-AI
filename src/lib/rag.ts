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

// TF-IDF keyword embedding: term frequency vector over top-N terms
function tfidfVector(text: string, vocabulary: Map<string, number>): number[] {
  const tokens = tokenize(text);
  const freq = new Map<string, number>();
  for (const t of tokens) freq.set(t, (freq.get(t) ?? 0) + 1);

  const vec = new Array<number>(vocabulary.size).fill(0);
  for (const [term, count] of freq) {
    const idx = vocabulary.get(term);
    if (idx !== undefined) vec[idx] = count / tokens.length;
  }
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

  // Build vocabulary from all chunks for TF-IDF
  const vocab = new Map<string, number>();
  for (const chunk of chunks) {
    for (const token of tokenize(chunk)) {
      if (!vocab.has(token)) vocab.set(token, vocab.size);
    }
  }

  await prisma.knowledgeChunk.createMany({
    data: chunks.map((text, chunkIndex) => ({
      documentId: doc.id,
      chunkIndex,
      text,
      embedding: tfidfVector(text, vocab),
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

  // Rebuild vocabulary from stored chunks
  const vocab = new Map<string, number>();
  for (const chunk of chunks) {
    for (const token of tokenize(chunk.text)) {
      if (!vocab.has(token)) vocab.set(token, vocab.size);
    }
  }

  const queryVec = tfidfVector(query, vocab);

  const scored = chunks.map((chunk) => ({
    text: chunk.text,
    score: Array.isArray(chunk.embedding)
      ? cosineSimilarity(queryVec, chunk.embedding as number[])
      : 0,
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK).map((c) => c.text);
}
