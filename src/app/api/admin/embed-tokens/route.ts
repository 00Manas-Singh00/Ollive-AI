import { NextRequest, NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { requireRole } from "@/lib/rbac";

async function requireAdmin() {
  const user = await requireSessionUser();
  requireRole(user, "ADMIN");
  return user;
}

const CreateTokenSchema = z.object({
  name: z.string().optional(),
  promptProfileKey: z.string().optional(),
  allowedOrigins: z.array(z.string().url()).optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    const tokens = await prisma.embedToken.findMany({ orderBy: { createdAt: "desc" } });
    return NextResponse.json({ tokens });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireAdmin();
    const body = CreateTokenSchema.parse(await req.json());

    const token = await prisma.embedToken.create({
      data: {
        token: randomBytes(24).toString("hex"),
        userId: user.id,
        name: body.name,
        promptProfileKey: body.promptProfileKey,
        allowedOrigins: body.allowedOrigins ?? [],
      },
    });

    return NextResponse.json({ token });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 400 });
  }
}
