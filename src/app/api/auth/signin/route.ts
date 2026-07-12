import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { setSessionCookie } from "@/lib/auth";
import { verifyPassword } from "@/lib/password";

const signinSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

export async function POST(req: NextRequest) {
  const raw = await req.json().catch(() => ({}));
  const parsed = signinSchema.safeParse(raw);
  if (!parsed.success) return NextResponse.json({ error: "Email and password are required" }, { status: 400 });
  const { email, password } = parsed.data;

  const user = await prisma.user.findUnique({ where: { email } });
  if (!user?.passwordHash || !(await verifyPassword(password, user.passwordHash))) {
    return NextResponse.json({ error: "Invalid email or password" }, { status: 401 });
  }

  await setSessionCookie(user.id);
  return NextResponse.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
}
