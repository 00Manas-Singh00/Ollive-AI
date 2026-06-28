"use client";

import { useParams } from "next/navigation";
import { useState } from "react";
import MessageList from "@/components/chat/MessageList";

type Message = { id: string; role: string; content: string };

export default function EmbedChatPage() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const [messages, setMessages] = useState<Message[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setInput("");
    setError("");
    setMessages((prev) => [...prev, { id: `local-${Date.now()}`, role: "user", content: text }]);
    setLoading(true);
    try {
      const res = await fetch("/api/embed/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Embed-Token": token },
        body: JSON.stringify({ message: text, conversationId: conversationId ?? undefined }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
      setConversationId(data.conversationId);
      setMessages((prev) => [...prev, data.message]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to send message");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", background: "var(--bg)" }}>
      <div style={{ flex: 1, overflowY: "auto", padding: 16 }}>
        <MessageList messages={messages} />
        {error && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 8 }}>{error}</div>}
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Type a message…"
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) send(); }}
          />
          <button className="send-btn" onClick={send} disabled={loading || !input.trim()}>
            {loading ? "Sending…" : "Send"}
          </button>
        </div>
      </div>
    </div>
  );
}
