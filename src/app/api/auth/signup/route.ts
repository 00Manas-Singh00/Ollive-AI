import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { setSessionCookie } from "@/lib/auth";
import { hashPassword } from "@/lib/password";

const signupSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  name: z.string().trim().min(1).max(200).optional(),
  password: z.string().min(8).max(200),
});

export async function POST(req: NextRequest) {
  const raw = await req.json().catch(() => ({}));
  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message || "Invalid input" }, { status: 400 });
  const { email, name, password } = parsed.data;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: "An account with this email already exists" }, { status: 409 });

  const passwordHash = await hashPassword(password);
  const user = await prisma.user.create({ data: { email, name: name || email.split("@")[0], passwordHash } });
  await setSessionCookie(user.id);
  return NextResponse.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}
