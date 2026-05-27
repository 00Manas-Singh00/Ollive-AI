import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { setSessionCookie } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const email = String(body?.email || "").trim().toLowerCase();
  const name = String(body?.name || "").trim();
  if (!email) return NextResponse.json({ error: "Email is required" }, { status: 400 });
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, name: name || email.split("@")[0] },
    update: { name: name || undefined },
  });
  await setSessionCookie(user.id);
  return NextResponse.json({ user: { id: user.id, email: user.email, name: user.name } });
}
