import { cookies } from "next/headers";
import { createHmac, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";

const COOKIE_NAME = "ollive_session";

function getSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET must be set and at least 32 characters long");
  }
  return secret;
}

function signUserId(userId: string): string {
  const sig = createHmac("sha256", getSecret()).update(userId).digest("hex");
  return `${userId}.${sig}`;
}

function verifyAndExtract(value: string): string | null {
  const dotIndex = value.lastIndexOf(".");
  if (dotIndex === -1) return null;
  const userId = value.slice(0, dotIndex);
  const providedSig = value.slice(dotIndex + 1);
  const expectedSig = createHmac("sha256", getSecret()).update(userId).digest("hex");
  try {
    const a = Buffer.from(providedSig, "hex");
    const b = Buffer.from(expectedSig, "hex");
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return userId;
}

export async function getSessionUser() {
  const store = await cookies();
  const raw = store.get(COOKIE_NAME)?.value;
  if (!raw) return null;
  const userId = verifyAndExtract(raw);
  if (!userId) return null;
  return prisma.user.findUnique({ where: { id: userId } });
}

export async function requireSessionUser() {
  const user = await getSessionUser();
  if (!user) throw new Error("UNAUTHORIZED");
  return user;
}

export async function setSessionCookie(userId: string) {
  const store = await cookies();
  store.set(COOKIE_NAME, signUserId(userId), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
}

export async function clearSessionCookie() {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}
