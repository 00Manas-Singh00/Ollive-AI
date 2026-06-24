"use client";

import { useRef } from "react";

type Props = {
  value: string;
  loading: boolean;
  disabled: boolean;
  conversationId: string | null;
  onChange: (v: string) => void;
  onSend: () => void;
  onFileUploaded?: (documentId: string, filename: string) => void;
};

export default function ChatInput({ value, loading, disabled, conversationId, onChange, onSend, onFileUploaded }: Props) {
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
          {loading ? "Streaming…" : "Send"}
        </button>
      </div>
    </div>
  );
}
