"use client";

import { useEffect, useMemo, useState } from "react";

type Message = { id: string; role: string; content: string };
type Conversation = { id: string; title: string; status: string; messages: Message[] };

export default function ChatUI() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function parseJsonSafe(res: Response) {
    const text = await res.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  async function refresh() {
    setError("");
    const res = await fetch("/api/conversations", { cache: "no-store" });
    const data = await parseJsonSafe(res);
    if (!res.ok) {
      setError(data?.error || `Failed to load conversations (${res.status})`);
      return;
    }
    setConversations(data?.conversations || []);
    if (!activeId && data?.conversations?.length) setActiveId(data.conversations[0].id);
  }

  useEffect(() => {
    refresh();
  }, []);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId]
  );

  async function send() {
    const text = input.trim();
    if (!text || loading || active?.status === "paused") return;
    setError("");
    setLoading(true);
    setInput("");

    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId: activeId, message: text }),
    });

    const payload = await parseJsonSafe(res);
    if (res.ok && payload) {
      setActiveId(payload.conversationId);
      await refresh();
    } else {
      setError(payload?.error || `Chat request failed (${res.status})`);
    }

    setLoading(false);
  }

  async function updateConversationStatus(id: string, action: "pause" | "resume") {
    await fetch(`/api/conversations/${id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action }),
    });
    await refresh();
  }

  async function deleteConversation(id: string) {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (activeId === id) setActiveId(null);
    await refresh();
  }

  function startNewConversation() {
    setActiveId(null);
    setError("");
    setInput("");
  }

  return (
    <main className="chat-shell">
      <aside className="chat-sidebar">
        <div className="brand-row">
          <div>
            <p className="brand-kicker">OlliveAI</p>
            <h2 className="brand-title">Conversations</h2>
          </div>
          <button className="ghost-btn" onClick={startNewConversation}>New</button>
        </div>

        <div className="thread-list">
          {conversations.map((c) => (
            <article
              key={c.id}
              className={`thread-card ${c.id === activeId ? "active" : ""}`}
              onClick={() => setActiveId(c.id)}
            >
              <h3>{c.title}</h3>
              <div className="thread-meta">
                <span className={`status ${c.status}`}>{c.status}</span>
              </div>
              <div className="thread-actions">
                {c.status === "active" && (
                  <button
                    className="mini-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateConversationStatus(c.id, "pause");
                    }}
                  >
                    Pause
                  </button>
                )}
                {c.status === "paused" && (
                  <button
                    className="mini-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      updateConversationStatus(c.id, "resume");
                    }}
                  >
                    Resume
                  </button>
                )}
                <button
                  className="mini-btn danger"
                  onClick={(e) => {
                    e.stopPropagation();
                    deleteConversation(c.id);
                  }}
                >
                  Delete
                </button>
              </div>
            </article>
          ))}
        </div>
      </aside>

      <section className="chat-main">
        <header className="chat-header">
          <h1>{active ? active.title : "Start a new conversation"}</h1>
          <p>Ask anything. Conversations are logged with inference telemetry.</p>
        </header>

        {error && <p className="error-banner">{error}</p>}

        <div className="message-pane">
          {active?.messages?.length ? (
            active.messages.map((m, i) => (
              <div
                key={m.id}
                className={`bubble-row ${m.role === "user" ? "user" : "assistant"}`}
                style={{ animationDelay: `${i * 30}ms` }}
              >
                <div className="bubble">
                  <p>{m.content}</p>
                </div>
              </div>
            ))
          ) : (
            <div className="empty-state">
              <h3>New thread ready</h3>
              <p>Send your first message to begin the conversation.</p>
            </div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Message OlliveAI"
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
            />
            <button className="send-btn" onClick={send} disabled={loading || active?.status === "paused"}>
              {loading ? "Sending" : "Send"}
            </button>
          </div>
          {active?.status === "paused" && (
            <p className="status-note">This conversation is paused. Click Resume in the sidebar.</p>
          )}
        </div>
      </section>
    </main>
  );
}
