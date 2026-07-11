import Redis from "ioredis";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { ConversationMemberRole, type Conversation } from "@prisma/client";

const MEMBER_RANK: Record<ConversationMemberRole, number> = {
  VIEWER: 0,
  COLLABORATOR: 1,
  OWNER: 2,
};

export type ConversationAccess = {
  conversation: Conversation;
  role: ConversationMemberRole;
};

// The conversation creator is always OWNER, whether or not a ConversationMember
// row exists for them (rows are only created for invited collaborators).
export async function assertConversationAccess(
  user: { id: string },
  conversationId: string,
  minRole: ConversationMemberRole,
): Promise<ConversationAccess> {
  const conversation = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!conversation) {
    throw Object.assign(new Error("NOT_FOUND"), { status: 404 });
  }

  if (conversation.userId === user.id) {
    return { conversation, role: "OWNER" };
  }

  const membership = await prisma.conversationMember.findUnique({
    where: { conversationId_userId: { conversationId, userId: user.id } },
    select: { role: true },
  });
  if (!membership || MEMBER_RANK[membership.role] < MEMBER_RANK[minRole]) {
    throw Object.assign(new Error("FORBIDDEN"), { status: 403 });
  }
  return { conversation, role: membership.role };
}

// Shared catch-block mapping for routes using assertConversationAccess/requireSessionUser.
// Returns null when the error isn't one of these known auth shapes, so callers can fall
// through to their own generic 500 handling.
export function collabErrorResponse(error: unknown): NextResponse | null {
  if (error instanceof Error && error.message === "UNAUTHORIZED") {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (error instanceof Error && error.message === "NOT_FOUND") {
    return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  }
  const status = (error as { status?: number } | null)?.status;
  if (status === 403) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (status === 404) return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
  return null;
}

let cachedClient: Redis | null = null;

function getRedis(): Redis | null {
  if (cachedClient) return cachedClient;
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) return null;
  cachedClient = new Redis(redisUrl);
  return cachedClient;
}

export function conversationChannel(conversationId: string): string {
  return `collab:${conversationId}`;
}

export type CollabEvent =
  | { type: "message_created"; message: unknown }
  | { type: "token"; messageId: string; token: string }
  | { type: "thought"; messageId: string; thought: string }
  | { type: "presence"; userId: string; name: string }
  | { type: "annotation_updated"; messageId: string };

// Fire-and-forget by convention at call sites — never awaited on the hot streaming path.
export async function publishConversationEvent(conversationId: string, event: CollabEvent): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.publish(conversationChannel(conversationId), JSON.stringify(event));
}

const SEND_LOCK_TTL_SECONDS = 30;

function sendLockKey(conversationId: string): string {
  return `collab:lock:${conversationId}`;
}

// Only one member may have an in-flight send per collaborative conversation at a time.
export async function acquireSendLock(conversationId: string): Promise<boolean> {
  const redis = getRedis();
  if (!redis) return true;
  const result = await redis.set(sendLockKey(conversationId), "1", "EX", SEND_LOCK_TTL_SECONDS, "NX");
  return result === "OK";
}

export async function releaseSendLock(conversationId: string): Promise<void> {
  const redis = getRedis();
  if (!redis) return;
  await redis.del(sendLockKey(conversationId));
}

// SUBSCRIBE requires a dedicated ioredis connection separate from the cached
// publish/lock client — callers must .quit() this on request abort.
export function createSubscriberConnection(): Redis {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is not configured");
  return new Redis(redisUrl);
}
