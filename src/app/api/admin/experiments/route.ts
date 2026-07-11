import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { requireSessionUser } from "@/lib/auth";
import { requireRole } from "@/lib/rbac";
import { z } from "zod";
import { MAX_TRAFFIC_SPLIT, generateChallenger, evaluateExperiment } from "@/lib/prompt-lab";

async function requireAdmin() {
  const user = await requireSessionUser();
  requireRole(user, "ADMIN");
  return user;
}

const CreateExperimentSchema = z.object({
  profileKey: z.string().min(1),
  challengerVersionId: z.string().min(1).optional(),
  generateChallenger: z.boolean().optional(),
  trafficSplit: z.number().min(0.01).max(MAX_TRAFFIC_SPLIT).optional(),
  minSamples: z.number().int().min(1).max(100000).optional(),
  autoPromote: z.boolean().optional(),
});

export async function GET() {
  try {
    await requireAdmin();
    const experiments = await prisma.promptExperiment.findMany({
      include: { championVersion: true, challengerVersion: true },
      orderBy: { createdAt: "desc" },
    });

    // Live metrics for anything still running, without persisting (persistence happens in the worker).
    const withLiveMetrics = await Promise.all(
      experiments.map(async (experiment) => {
        if (experiment.status !== "RUNNING") return experiment;
        const evaluation = await evaluateExperiment(experiment.id).catch(() => null);
        return evaluation ? { ...experiment, liveMetrics: evaluation } : experiment;
      }),
    );

    return NextResponse.json({ experiments: withLiveMetrics });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json();
    const data = CreateExperimentSchema.parse(body);

    const profile = await prisma.promptProfile.findUnique({ where: { key: data.profileKey } });
    if (!profile) return NextResponse.json({ error: "Profile not found" }, { status: 404 });

    const existing = await prisma.promptExperiment.findFirst({ where: { profileKey: data.profileKey, status: "RUNNING" } });
    if (existing) return NextResponse.json({ error: "An experiment is already running for this profile" }, { status: 409 });

    const championVersion = await prisma.promptVersion.findFirst({ where: { profileId: profile.id, version: profile.activeVersion ?? 1 } });
    if (!championVersion) return NextResponse.json({ error: "Active version not found" }, { status: 404 });

    let challengerVersionId = data.challengerVersionId;
    if (!challengerVersionId) {
      if (!data.generateChallenger) return NextResponse.json({ error: "challengerVersionId or generateChallenger is required" }, { status: 400 });
      const challenger = await generateChallenger(data.profileKey);
      challengerVersionId = challenger.id;
    }

    const experiment = await prisma.promptExperiment.create({
      data: {
        profileKey: data.profileKey,
        championVersionId: championVersion.id,
        challengerVersionId,
        trafficSplit: data.trafficSplit ?? 0.1,
        minSamples: data.minSamples ?? 100,
        autoPromote: data.autoPromote ?? false,
      },
      include: { championVersion: true, challengerVersion: true },
    });

    return NextResponse.json({ experiment }, { status: 201 });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (msg === "FORBIDDEN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    if (error instanceof z.ZodError) return NextResponse.json({ error: error.errors }, { status: 400 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
