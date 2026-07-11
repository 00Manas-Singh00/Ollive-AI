import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { moderateInput } from "@/lib/safety";
import { validateCronExpression } from "@/lib/cron-validate";
import { PROVIDER_NAMES } from "@/lib/llm";
import { syncScheduleJob, removeScheduleJob, MAX_SCHEDULES_PER_USER } from "@/lib/scheduled-prompts";

const PatchSchema = z.object({
  cronExpression: z.string().min(1).max(100).optional(),
  prompt: z.string().min(1).max(4000).optional(),
  provider: z.enum(PROVIDER_NAMES as [string, ...string[]]).optional(),
  isActive: z.boolean().optional(),
});

type Params = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;
    const patch = PatchSchema.parse(await req.json());

    const existing = await prisma.scheduledPrompt.findFirst({ where: { id, userId: user.id } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (patch.cronExpression) {
      const cronError = validateCronExpression(patch.cronExpression);
      if (cronError) return NextResponse.json({ error: cronError }, { status: 400 });
    }
    if (patch.prompt && moderateInput(patch.prompt).blocked) {
      return NextResponse.json({ error: "Prompt was blocked by content safety rules" }, { status: 400 });
    }
    if (patch.isActive === true && !existing.isActive) {
      const activeCount = await prisma.scheduledPrompt.count({ where: { userId: user.id, isActive: true } });
      if (activeCount >= MAX_SCHEDULES_PER_USER) {
        return NextResponse.json({ error: `Maximum of ${MAX_SCHEDULES_PER_USER} active schedules per user` }, { status: 400 });
      }
    }

    const updated = await prisma.scheduledPrompt.update({ where: { id }, data: patch });
    await syncScheduleJob(updated);

    return NextResponse.json({ schedule: updated });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues }, { status: 400 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest, { params }: Params) {
  try {
    const user = await requireSessionUser();
    const { id } = await params;

    const existing = await prisma.scheduledPrompt.findFirst({ where: { id, userId: user.id } });
    if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await removeScheduleJob(id);
    await prisma.scheduledPrompt.delete({ where: { id } });

    return NextResponse.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
