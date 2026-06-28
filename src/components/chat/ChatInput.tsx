"use client";

import { useRef } from "react";

const RACE_PROVIDER_OPTIONS = ["gemini", "grok", "openai", "anthropic", "ollama"] as const;

type Props = {
  value: string;
  loading: boolean;
  disabled: boolean;
  conversationId: string | null;
  onChange: (v: string) => void;
  onSend: () => void;
  onFileUploaded?: (documentId: string, filename: string) => void;
  raceMode?: boolean;
  raceProviders?: string[];
  onToggleRaceMode?: () => void;
  onToggleRaceProvider?: (provider: string) => void;
};

export default function ChatInput({
  value,
  loading,
  disabled,
  conversationId,
  onChange,
  onSend,
  onFileUploaded,
  raceMode = false,
  raceProviders = [],
  onToggleRaceMode,
  onToggleRaceProvider,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !conversationId) return;
    e.target.value = "";

    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`/api/conversations/${conversationId}/documents`, {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    if (res.ok && data.documentId) {
      onFileUploaded?.(data.documentId, file.name);
    }
  }

  return (
    <div className="composer-wrap">
      {onToggleRaceMode && (
        <div className="race-toolbar">
          <button
            className={`mini-btn${raceMode ? " active" : ""}`}
            onClick={onToggleRaceMode}
            title="Fan this prompt out to multiple providers side-by-side"
          >
            🏁 Race mode
          </button>
          {raceMode && (
            <div className="race-provider-picker">
              {RACE_PROVIDER_OPTIONS.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`race-chip${raceProviders.includes(p) ? " selected" : ""}`}
                  onClick={() => onToggleRaceProvider?.(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <div className="composer">
        <button
          className="mini-btn"
          title="Attach file"
          disabled={!conversationId}
          onClick={() => fileRef.current?.click()}
          style={{ fontSize: 18, padding: "0 8px" }}
        >
          📎
        </button>
        <input ref={fileRef} type="file" accept=".txt,.md,.csv,.json" style={{ display: "none" }} onChange={handleFile} />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Message OlliveAI"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) onSend(); }}
        />
        <button className="send-btn" onClick={onSend} disabled={disabled}>
          {loading ? "Streaming…" : raceMode ? "Race" : "Send"}
        </button>
      </div>
    </div>
  );
}
