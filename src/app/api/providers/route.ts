import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth";
import { configuredProviders, providerModel } from "@/lib/llm";

export async function GET() {
  try {
    await requireSessionUser();
    const providers = configuredProviders().map((provider) => ({ provider, model: providerModel(provider) }));
    return NextResponse.json({ providers });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
