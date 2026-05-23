"use client";

import { useEffect, useState } from "react";

type Message = { id: string; role: string; content: string };
type Conversation = { id: string; title: string; status: string; messages: Message[] };

export default function ChatUI() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function refresh() {
    const res = await fetch("/api/conversations", { cache: "no-store" });
    const data = await res.json();
    setConversations(data.conversations || []);
    if (!activeId && data.conversations?.length) setActiveId(data.conversations[0].id);
  }

  useEffect(() => {
    refresh();
  }, []);

  const active = conversations.find((c) => c.id === activeId) || null;

  async function send() {
    const text = input.trim();
    if (!text || loading) return;
    setLoading(true);
    setInput("");

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: activeId, message: text }),
    });

    if (res.ok) {
      const payload = await res.json();
      setActiveId(payload.conversationId);
      await refresh();
    }

    setLoading(false);
  }

  async function cancelConversation(id: string) {
    await fetch(`/api/conversations/${id}/cancel`, { method: "POST" });
    await refresh();
  }

  return (
    <main style={{ display: "grid", gridTemplateColumns: "300px 1fr", minHeight: "100vh" }}>
      <aside style={{ borderRight: "1px solid var(--line)", padding: 16 }}>
        <h2>Conversations</h2>
        {conversations.map((c) => (
          <div key={c.id} style={{ marginBottom: 10, padding: 10, background: "var(--panel)", border: "1px solid var(--line)" }}>
            <button onClick={() => setActiveId(c.id)} style={{ fontWeight: 700, border: 0, background: "transparent", cursor: "pointer" }}>
              {c.title}
            </button>
            <div style={{ fontSize: 12, color: "var(--muted)" }}>{c.status}</div>
            {c.status === "active" && (
              <button onClick={() => cancelConversation(c.id)} style={{ marginTop: 8 }}>
                Cancel
              </button>
            )}
          </div>
        ))}
      </aside>
      <section style={{ padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
        <h1>LLM Chatbot with Inference Logging</h1>
        <div style={{ flex: 1, overflowY: "auto", border: "1px solid var(--line)", padding: 16, background: "var(--panel)" }}>
          {active?.messages.map((m) => (
            <p key={m.id}><strong>{m.role}:</strong> {m.content}</p>
          ))}
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Type your message" style={{ flex: 1, padding: 10 }} />
          <button onClick={send} disabled={loading}>{loading ? "Sending..." : "Send"}</button>
        </div>
      </section>
    </main>
  );
}
