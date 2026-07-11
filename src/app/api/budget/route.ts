import { NextResponse } from "next/server";
import { requireSessionUser } from "@/lib/auth";
import { checkBudget } from "@/lib/budget";

export async function GET() {
  try {
    const user = await requireSessionUser();
    const budget = await checkBudget(user.id);
    return NextResponse.json(budget);
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Error";
    if (msg === "UNAUTHORIZED") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
