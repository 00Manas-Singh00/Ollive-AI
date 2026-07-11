"use client";

import { useEffect, useState } from "react";

type Schedule = {
  id: string;
  cronExpression: string;
  prompt: string;
  provider: string;
  isActive: boolean;
  lastRunAt: string | null;
};

type Frequency = "daily" | "weekly" | "monthly";

const PROVIDERS = ["gemini", "grok", "openai", "anthropic", "ollama"];
const WEEKDAYS = [
  { value: "1", label: "Monday" },
  { value: "2", label: "Tuesday" },
  { value: "3", label: "Wednesday" },
  { value: "4", label: "Thursday" },
  { value: "5", label: "Friday" },
  { value: "6", label: "Saturday" },
  { value: "0", label: "Sunday" },
];

// Maps the simple frequency picker to a 5-field cron expression, interpreted in
// the server's local time (BullMQ registers it as-is; no timezone conversion here).
function toCronExpression(frequency: Frequency, time: string, weekday: string, dayOfMonth: string): string {
  const [hh, mm] = time.split(":");
  const minute = String(Number(mm) || 0);
  const hour = String(Number(hh) || 0);
  if (frequency === "daily") return `${minute} ${hour} * * *`;
  if (frequency === "weekly") return `${minute} ${hour} * * ${weekday}`;
  return `${minute} ${hour} ${dayOfMonth} * *`;
}

async function parseJsonSafe(res: Response) {
  const t = await res.text();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

export default function ScheduleModal({ onClose }: { onClose: () => void }) {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [prompt, setPrompt] = useState("");
  const [provider, setProvider] = useState("gemini");
  const [frequency, setFrequency] = useState<Frequency>("weekly");
  const [time, setTime] = useState("09:00");
  const [weekday, setWeekday] = useState("1");
  const [dayOfMonth, setDayOfMonth] = useState("1");
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    setLoading(true);
    const res = await fetch("/api/schedules", { cache: "no-store" });
    const data = await parseJsonSafe(res);
    if (res.ok) setSchedules(data?.schedules ?? []);
    else setError(data?.error || `Failed to load schedules (${res.status})`);
    setLoading(false);
  }

  useEffect(() => { void load(); }, []);

  async function createSchedule() {
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError("");
    const res = await fetch("/api/schedules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        cronExpression: toCronExpression(frequency, time, weekday, dayOfMonth),
        prompt: prompt.trim(),
        provider,
      }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) setError(data?.error || `Create failed (${res.status})`);
    else {
      setPrompt("");
      await load();
    }
    setSubmitting(false);
  }

  async function toggleActive(schedule: Schedule) {
    await fetch(`/api/schedules/${schedule.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive: !schedule.isActive }),
    });
    await load();
  }

  async function deleteSchedule(id: string) {
    await fetch(`/api/schedules/${id}`, { method: "DELETE" });
    await load();
  }

  return (
    <div className="report-overlay" onClick={onClose}>
      <aside className="report-panel" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <h3>Scheduled Prompts</h3>
          <button className="mini-btn ghost" onClick={onClose} title="Close">×</button>
        </div>

        <div className="report-body">
          <section>
            <h4>New Schedule</h4>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. Summarize my conversations from this week"
              rows={3}
              style={{ width: "100%", resize: "vertical" }}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 8 }}>
              <select value={provider} onChange={(e) => setProvider(e.target.value)}>
                {PROVIDERS.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <select value={frequency} onChange={(e) => setFrequency(e.target.value as Frequency)}>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
              </select>
              {frequency === "weekly" && (
                <select value={weekday} onChange={(e) => setWeekday(e.target.value)}>
                  {WEEKDAYS.map((w) => <option key={w.value} value={w.value}>{w.label}</option>)}
                </select>
              )}
              {frequency === "monthly" && (
                <input
                  type="number"
                  min={1}
                  max={31}
                  value={dayOfMonth}
                  onChange={(e) => setDayOfMonth(e.target.value)}
                  style={{ width: 60 }}
                  title="Day of month"
                />
              )}
              <input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
            </div>
            <button className="mini-btn" style={{ marginTop: 8 }} disabled={submitting || !prompt.trim()} onClick={createSchedule}>
              {submitting ? "Creating…" : "Create Schedule"}
            </button>
          </section>

          {error && <p className="report-error">{error}</p>}

          <section>
            <h4>Your Schedules</h4>
            {loading && <p>Loading…</p>}
            {!loading && schedules.length === 0 && <p style={{ color: "var(--text-muted)", fontSize: 13.5 }}>No scheduled prompts yet.</p>}
            <ul className="report-list" style={{ listStyle: "none", padding: 0, display: "flex", flexDirection: "column", gap: 10 }}>
              {schedules.map((s) => (
                <li key={s.id} style={{ border: "1px solid var(--border, rgba(255,255,255,0.08))", borderRadius: 8, padding: 10 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <strong style={{ fontSize: 13 }}>{s.prompt.length > 80 ? `${s.prompt.slice(0, 80)}…` : s.prompt}</strong>
                    <span style={{ color: s.isActive ? "#22c55e" : "var(--text-muted)", fontSize: 12 }}>{s.isActive ? "active" : "paused"}</span>
                  </div>
                  <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "4px 0" }}>
                    {s.provider} · <code>{s.cronExpression}</code>
                    {s.lastRunAt ? ` · last run ${new Date(s.lastRunAt).toLocaleString()}` : " · never run"}
                  </p>
                  <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                    <button className="mini-btn" onClick={() => toggleActive(s)}>{s.isActive ? "Pause" : "Resume"}</button>
                    <button className="mini-btn danger" onClick={() => deleteSchedule(s.id)}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        </div>
      </aside>
    </div>
  );
}
