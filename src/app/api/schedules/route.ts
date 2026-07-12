import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireSessionUser } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { moderateInput } from "@/lib/safety";
import { validateCronExpression } from "@/lib/cron-validate";
import { PROVIDER_NAMES } from "@/lib/llm";
import { syncScheduleJob, MAX_SCHEDULES_PER_USER } from "@/lib/scheduled-prompts";

const CreateSchema = z.object({
  cronExpression: z.string().min(1).max(100),
  prompt: z.string().min(1).max(4000),
  provider: z.enum(PROVIDER_NAMES as [string, ...string[]]),
});

export async function GET() {
  try {
    const user = await requireSessionUser();
    const schedules = await prisma.scheduledPrompt.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ schedules });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const user = await requireSessionUser();
    const body = CreateSchema.parse(await req.json());

    const cronError = validateCronExpression(body.cronExpression);
    if (cronError) return NextResponse.json({ error: cronError }, { status: 400 });

    const activeCount = await prisma.scheduledPrompt.count({ where: { userId: user.id, isActive: true } });
    if (activeCount >= MAX_SCHEDULES_PER_USER) {
      return NextResponse.json({ error: `Maximum of ${MAX_SCHEDULES_PER_USER} active schedules per user` }, { status: 400 });
    }

    const inputModeration = await moderateInput(body.prompt);
    if (inputModeration.blocked) {
      return NextResponse.json({ error: "Prompt was blocked by content safety rules" }, { status: 400 });
    }

    const schedule = await prisma.scheduledPrompt.create({
      data: { userId: user.id, cronExpression: body.cronExpression, prompt: body.prompt, provider: body.provider },
    });
    await syncScheduleJob(schedule);

    return NextResponse.json({ schedule });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.issues }, { status: 400 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
