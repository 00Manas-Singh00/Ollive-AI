"use client";

import { useEffect, useState } from "react";

type Sentiment = "positive" | "neutral" | "negative";
type ReportData = {
  summary: string;
  topics: string[];
  sentimentArc: Array<{ turn: number; sentiment: Sentiment }>;
  actionItems: string[];
  unresolvedQuestions: string[];
};

const SENTIMENT_Y: Record<Sentiment, number> = { positive: 4, neutral: 20, negative: 36 };
const SENTIMENT_COLOR: Record<Sentiment, string> = { positive: "#22c55e", neutral: "#f59e0b", negative: "#ef4444" };

function SentimentSparkline({ arc }: { arc: ReportData["sentimentArc"] }) {
  if (arc.length === 0) return null;
  const w = 100;
  const h = 40;
  const points = arc.map((a, i) => ({
    ...a,
    x: arc.length === 1 ? w / 2 : (i / (arc.length - 1)) * w,
    y: SENTIMENT_Y[a.sentiment],
  }));
  return (
    <svg className="report-sparkline" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline
        points={points.map((p) => `${p.x},${p.y}`).join(" ")}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
      {points.map((p) => (
        <circle key={p.turn} cx={p.x} cy={p.y} r={2.5} fill={SENTIMENT_COLOR[p.sentiment]}>
          <title>{`Turn ${p.turn}: ${p.sentiment}`}</title>
        </circle>
      ))}
    </svg>
  );
}

function toMarkdown(report: ReportData): string {
  const lines = [
    "# Conversation Report",
    "",
    "## Summary",
    report.summary,
    "",
    "## Topics",
    ...report.topics.map((t) => `- ${t}`),
    "",
    "## Action Items",
    ...(report.actionItems.length ? report.actionItems.map((t) => `- [ ] ${t}`) : ["- (none)"]),
    "",
    "## Unresolved Questions",
    ...(report.unresolvedQuestions.length ? report.unresolvedQuestions.map((t) => `- ${t}`) : ["- (none)"]),
  ];
  return lines.join("\n");
}

export default function ReportPanel({ conversationId, onClose }: { conversationId: string; onClose: () => void }) {
  const [report, setReport] = useState<ReportData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);
  const [checked, setChecked] = useState<Record<number, boolean>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    fetch(`/api/conversations/${conversationId}/report`, { method: "POST" })
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (cancelled) return;
        if (!r.ok) {
          setError(data?.error || `Report failed (${r.status})`);
          return;
        }
        setReport(data.report);
      })
      .catch(() => { if (!cancelled) setError("Report generation failed"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [conversationId]);

  async function copyMarkdown() {
    if (!report) return;
    await navigator.clipboard.writeText(toMarkdown(report));
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div className="report-overlay" onClick={onClose}>
      <aside className="report-panel" onClick={(e) => e.stopPropagation()}>
        <div className="report-head">
          <h3>Conversation Report</h3>
          <button className="mini-btn ghost" onClick={onClose} title="Close">×</button>
        </div>

        {loading && (
          <div className="report-skeleton">
            <div className="skeleton-line" style={{ width: "90%" }} />
            <div className="skeleton-line" style={{ width: "70%" }} />
            <div className="skeleton-line" style={{ width: "80%" }} />
            <div className="skeleton-line" style={{ width: "50%" }} />
          </div>
        )}

        {!loading && error && <p className="report-error">{error}</p>}

        {!loading && !error && report && (
          <div className="report-body">
            <section>
              <h4>Summary</h4>
              <p>{report.summary}</p>
            </section>

            {report.topics.length > 0 && (
              <section>
                <h4>Topics</h4>
                <div className="report-topic-row">
                  {report.topics.map((t) => (
                    <span key={t} className="report-topic-chip">{t}</span>
                  ))}
                </div>
              </section>
            )}

            {report.sentimentArc.length > 0 && (
              <section>
                <h4>Sentiment Arc</h4>
                <SentimentSparkline arc={report.sentimentArc} />
              </section>
            )}

            {report.actionItems.length > 0 && (
              <section>
                <h4>Action Items</h4>
                <ul className="report-checklist">
                  {report.actionItems.map((item, i) => (
                    <li key={i}>
                      <label>
                        <input type="checkbox" checked={!!checked[i]} onChange={() => setChecked((c) => ({ ...c, [i]: !c[i] }))} />
                        <span className={checked[i] ? "checked" : ""}>{item}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {report.unresolvedQuestions.length > 0 && (
              <section>
                <h4>Unresolved Questions</h4>
                <ul className="report-list">
                  {report.unresolvedQuestions.map((q, i) => <li key={i}>{q}</li>)}
                </ul>
              </section>
            )}

            <button className="mini-btn" onClick={copyMarkdown}>{copied ? "Copied" : "Copy as Markdown"}</button>
          </div>
        )}
      </aside>
    </div>
  );
}
