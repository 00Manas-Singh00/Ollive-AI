"use client";

import { useEffect, useState } from "react";

type ToolCall = {
  id: string;
  toolName: string;
  arguments: unknown;
  result: unknown;
  status: "PENDING" | "SUCCESS" | "ERROR";
  latencyMs: number | null;
};

function ToolCallRow({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`tool-call-row${call.status === "ERROR" ? " error" : ""}`}>
      <button className="tool-call-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="tool-call-icon">{call.status === "ERROR" ? "⚠" : "🛠"}</span>
        <span className="tool-call-name">{call.toolName}</span>
        <span className="tool-call-args">{JSON.stringify(call.arguments)}</span>
        {call.latencyMs !== null && <span className="tool-call-latency">{call.latencyMs}ms</span>}
        <span className="tool-call-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <pre className="tool-call-result">{JSON.stringify(call.result, null, 2)}</pre>
      )}
    </div>
  );
}

export default function ToolCallCard({ messageId }: { messageId: string }) {
  const [toolCalls, setToolCalls] = useState<ToolCall[]>([]);

  useEffect(() => {
    fetch(`/api/messages/${messageId}/tool-calls`)
      .then((r) => r.json())
      .then((data: ToolCall[]) => {
        if (Array.isArray(data)) setToolCalls(data);
      })
      .catch(() => {});
  }, [messageId]);

  if (toolCalls.length === 0) return null;

  return (
    <div className="tool-call-card">
      {toolCalls.map((call) => (
        <ToolCallRow key={call.id} call={call} />
      ))}
    </div>
  );
}
