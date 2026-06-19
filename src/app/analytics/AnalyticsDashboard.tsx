"use client";

import { useEffect, useState, useCallback } from "react";
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
} from "recharts";

type InferenceData = {
  series: { date: string; count: number; errors: number; avgLatencyMs: number; tokens: number }[];
  byProvider: Record<string, number>;
  total: number;
};
type SafetyData = {
  total: number;
  byAction: Record<string, number>;
  byCategory: Record<string, number>;
  series: { date: string; blocked: number; allowed: number }[];
};
type CostData = {
  totalUsd: number;
  byProvider: Record<string, number>;
  series: { date: string; usd: number }[];
};
type AbData = {
  results: { profileKey: string; variants: { variant: string; count: number }[] }[];
  total: number;
};

const COLORS = ["#6366f1", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6", "#a855f7"];

function SectionHeader({ title }: { title: string }) {
  return <h2 style={{ margin: "2rem 0 1rem", fontSize: "1.1rem", fontWeight: 600, color: "var(--text-primary)" }}>{title}</h2>;
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "1rem 1.5rem", minWidth: 140 }}>
      <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</p>
      <p style={{ margin: "0.25rem 0 0", fontSize: "1.5rem", fontWeight: 700, color: "var(--text-primary)" }}>{value}</p>
    </div>
  );
}

export default function AnalyticsDashboard() {
  const [range, setRange] = useState("7d");
  const [inference, setInference] = useState<InferenceData | null>(null);
  const [safety, setSafety] = useState<SafetyData | null>(null);
  const [cost, setCost] = useState<CostData | null>(null);
  const [ab, setAb] = useState<AbData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    const days = range === "1d" ? 1 : range === "30d" ? 30 : 7;
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const to = new Date().toISOString();
    const qs = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;

    try {
      const [iRes, sRes, cRes, aRes] = await Promise.all([
        fetch(`/api/analytics/inference?${qs}`),
        fetch(`/api/analytics/safety?${qs}`),
        fetch(`/api/analytics/cost?${qs}`),
        fetch(`/api/analytics/ab-results?${qs}`),
      ]);
      if (!iRes.ok || !sRes.ok || !cRes.ok || !aRes.ok) throw new Error("Failed to load analytics");
      const [iData, sData, cData, aData] = await Promise.all([iRes.json(), sRes.json(), cRes.json(), aRes.json()]);
      setInference(iData);
      setSafety(sData);
      setCost(cData);
      setAb(aData);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unknown error");
    } finally {
      setLoading(false);
    }
  }, [range]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  const providerPie = inference
    ? Object.entries(inference.byProvider).map(([name, value]) => ({ name, value }))
    : [];

  const safetyPie = safety
    ? Object.entries(safety.byAction).map(([name, value]) => ({ name, value }))
    : [];

  return (
    <div style={{ padding: "2rem", maxWidth: 1100, margin: "0 auto", fontFamily: "var(--font-sans, system-ui)" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "1.5rem" }}>
        <h1 style={{ margin: 0, fontSize: "1.4rem", fontWeight: 700, color: "var(--text-primary)" }}>Analytics</h1>
        <div style={{ display: "flex", gap: 8 }}>
          {["1d", "7d", "30d"].map((r) => (
            <button
              key={r}
              onClick={() => setRange(r)}
              style={{
                padding: "4px 14px", borderRadius: 6, border: "1px solid var(--border)",
                background: range === r ? "var(--accent, #6366f1)" : "var(--surface)",
                color: range === r ? "#fff" : "var(--text-primary)",
                cursor: "pointer", fontWeight: 500, fontSize: "0.85rem",
              }}
            >{r}</button>
          ))}
        </div>
      </div>

      {error && <p style={{ color: "#ef4444" }}>{error}</p>}
      {loading && <p style={{ color: "var(--text-muted)" }}>Loading…</p>}

      {!loading && inference && safety && cost && (
        <>
          {/* KPI row */}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginBottom: "0.5rem" }}>
            <StatCard label="Total Inferences" value={inference.total.toLocaleString()} />
            <StatCard label="Safety Events" value={safety.total.toLocaleString()} />
            <StatCard label="Blocked" value={(safety.byAction["blocked"] ?? 0).toLocaleString()} />
            <StatCard label="Est. Cost" value={`$${cost.totalUsd.toFixed(4)}`} />
          </div>

          {/* Inference volume */}
          <SectionHeader title="Inference Volume" />
          <ResponsiveContainer width="100%" height={220}>
            <LineChart data={inference.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Line type="monotone" dataKey="count" stroke="#6366f1" name="Requests" dot={false} />
              <Line type="monotone" dataKey="errors" stroke="#ef4444" name="Errors" dot={false} />
            </LineChart>
          </ResponsiveContainer>

          {/* Latency */}
          <SectionHeader title="Avg Latency (ms)" />
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={inference.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="avgLatencyMs" fill="#6366f1" name="Avg Latency ms" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>

          {/* Provider split + Safety actions */}
          <div style={{ display: "flex", gap: 24, flexWrap: "wrap" }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <SectionHeader title="Requests by Provider" />
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={providerPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label>
                    {providerPie.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>

            <div style={{ flex: 1, minWidth: 260 }}>
              <SectionHeader title="Safety Actions" />
              <ResponsiveContainer width="100%" height={200}>
                <PieChart>
                  <Pie data={safetyPie} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={70} label>
                    {safetyPie.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Safety timeline */}
          <SectionHeader title="Safety Events Over Time" />
          <ResponsiveContainer width="100%" height={200}>
            <BarChart data={safety.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Legend />
              <Bar dataKey="allowed" fill="#22c55e" name="Allowed" stackId="a" />
              <Bar dataKey="blocked" fill="#ef4444" name="Blocked" stackId="a" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>

          {/* Cost */}
          <SectionHeader title="Estimated Cost (USD)" />
          <ResponsiveContainer width="100%" height={200}>
            <LineChart data={cost.series}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="date" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `$${v.toFixed(3)}`} />
              <Tooltip formatter={(v) => typeof v === "number" ? `$${v.toFixed(5)}` : v} />
              <Line type="monotone" dataKey="usd" stroke="#f59e0b" name="Cost USD" dot={false} />
            </LineChart>
          </ResponsiveContainer>

          {/* A/B Results */}
          {ab && ab.results.length > 0 && (
            <>
              <SectionHeader title="A/B Prompt Variant Distribution" />
              {ab.results.map((profile) => (
                <div key={profile.profileKey} style={{ marginBottom: "1.5rem" }}>
                  <p style={{ margin: "0 0 0.5rem", fontSize: "0.85rem", color: "var(--text-muted)", fontWeight: 500 }}>{profile.profileKey}</p>
                  <ResponsiveContainer width="100%" height={140}>
                    <BarChart data={profile.variants} layout="vertical">
                      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="variant" tick={{ fontSize: 11 }} width={60} />
                      <Tooltip />
                      <Bar dataKey="count" fill="#6366f1" radius={[0, 3, 3, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ))}
            </>
          )}
        </>
      )}
    </div>
  );
}
