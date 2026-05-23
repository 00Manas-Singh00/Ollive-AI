import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export async function POST(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const conversation = await prisma.conversation.update({
    where: { id },
    data: { status: "cancelled" },
  });
  return NextResponse.json({ conversation });
}
