import { requireSessionUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import AnalyticsDashboard from "./AnalyticsDashboard";

export const dynamic = "force-dynamic";

export default async function AnalyticsPage() {
  const user = await requireSessionUser().catch(() => null);
  if (!user) redirect("/");
  if (user.role !== "ANALYST" && user.role !== "PROMPT_EDITOR" && user.role !== "ADMIN") redirect("/");

  return <AnalyticsDashboard />;
}
