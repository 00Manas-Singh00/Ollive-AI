import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

export async function requireEmbedToken(req: NextRequest) {
  const token = req.headers.get("x-embed-token");
  if (!token) throw Object.assign(new Error("Missing X-Embed-Token header"), { status: 401 });

  const embedToken = await prisma.embedToken.findUnique({ where: { token }, include: { user: true } });
  if (!embedToken || !embedToken.isActive)
    throw Object.assign(new Error("Invalid or inactive embed token"), { status: 401 });

  // Empty allowedOrigins means the token owner hasn't restricted origins yet.
  const origin = req.headers.get("origin");
  if (embedToken.allowedOrigins.length > 0 && (!origin || !embedToken.allowedOrigins.includes(origin)))
    throw Object.assign(new Error("Origin not allowed for this embed token"), { status: 403 });

  return embedToken;
}

export function corsHeaders(req: NextRequest, embedToken: { allowedOrigins: string[] }): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowOrigin = embedToken.allowedOrigins.length === 0 ? (origin ?? "*") : origin ?? "";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-Embed-Token",
  };
}
