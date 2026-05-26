"use client";

import { useEffect, useMemo, useState } from "react";

type Message = { id: string; role: string; content: string };
type Conversation = {
  id: string;
  title: string;
  status: string;
  isArchived: boolean;
  isPinned: boolean;
  folder: string | null;
  tags: string[];
  messages: Message[];
};

export default function ChatUI() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);

  async function parseJsonSafe(res: Response) {
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  async function refresh() {
    setError("");
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (showArchived) params.set("includeArchived", "true");
    const res = await fetch(`/api/conversations?${params.toString()}`, { cache: "no-store" });
    const data = await parseJsonSafe(res);
    if (!res.ok) {
      setError(data?.error || `Failed to load conversations (${res.status})`);
      return;
    }
    setConversations(data?.conversations || []);
    if (!activeId && data?.conversations?.length) setActiveId(data.conversations[0].id);
  }

  useEffect(() => { refresh(); }, [search, showArchived]);

  const active = useMemo(
    () => conversations.find((c) => c.id === activeId) || null,
    [conversations, activeId]
  );

  async function updateConversation(id: string, patch: Record<string, unknown>) {
    await fetch(`/api/conversations/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    await refresh();
  }

  async function send() {
    const text = input.trim();
    if (!text || loading || active?.status === "paused" || active?.isArchived) return;
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

        <div className="search-row">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title or messages" />
          <button className="mini-btn" onClick={() => setShowArchived((v) => !v)}>{showArchived ? "Hide archived" : "Show archived"}</button>
        </div>

        <div className="thread-list">
          {conversations.map((c) => (
            <article key={c.id} className={`thread-card ${c.id === activeId ? "active" : ""}`} onClick={() => setActiveId(c.id)}>
              <h3>{c.title}</h3>
              <div className="thread-meta">
                <span className={`status ${c.status}`}>{c.status}</span>
                {c.isPinned && <span className="status"> pinned</span>}
                {c.isArchived && <span className="status"> archived</span>}
                {c.folder && <span className="status"> folder:{c.folder}</span>}
              </div>
              {!!c.tags.length && <p className="tag-row">{c.tags.map((tag) => `#${tag}`).join(" ")}</p>}
              <div className="thread-actions">
                <button className="mini-btn" onClick={(e) => { e.stopPropagation(); updateConversation(c.id, { isPinned: !c.isPinned }); }}>
                  {c.isPinned ? "Unpin" : "Pin"}
                </button>
                <button className="mini-btn" onClick={(e) => {
                  e.stopPropagation();
                  const title = window.prompt("Rename conversation", c.title);
                  if (title !== null) updateConversation(c.id, { title });
                }}>Rename</button>
                <button className="mini-btn" onClick={(e) => {
                  e.stopPropagation();
                  updateConversation(c.id, { isArchived: !c.isArchived });
                }}>{c.isArchived ? "Unarchive" : "Archive"}</button>
                <button className="mini-btn" onClick={(e) => {
                  e.stopPropagation();
                  const folder = window.prompt("Set folder (empty clears)", c.folder || "") ?? undefined;
                  if (folder !== undefined) updateConversation(c.id, { folder: folder.trim() ? folder.trim() : null });
                }}>Folder</button>
                <button className="mini-btn" onClick={(e) => {
                  e.stopPropagation();
                  const tagsRaw = window.prompt("Comma-separated tags", c.tags.join(", "));
                  if (tagsRaw !== null) {
                    const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);
                    updateConversation(c.id, { tags });
                  }
                }}>Tags</button>
                {c.status === "active" && <button className="mini-btn" onClick={(e) => { e.stopPropagation(); updateConversationStatus(c.id, "pause"); }}>Pause</button>}
                {c.status === "paused" && <button className="mini-btn" onClick={(e) => { e.stopPropagation(); updateConversationStatus(c.id, "resume"); }}>Resume</button>}
                <button className="mini-btn danger" onClick={(e) => { e.stopPropagation(); deleteConversation(c.id); }}>Delete</button>
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
              <div key={m.id} className={`bubble-row ${m.role === "user" ? "user" : "assistant"}`} style={{ animationDelay: `${i * 30}ms` }}>
                <div className="bubble"><p>{m.content}</p></div>
              </div>
            ))
          ) : (
            <div className="empty-state"><h3>New thread ready</h3><p>Send your first message to begin the conversation.</p></div>
          )}
        </div>

        <div className="composer-wrap">
          <div className="composer">
            <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Message OlliveAI" onKeyDown={(e) => { if (e.key === "Enter") send(); }} />
            <button className="send-btn" onClick={send} disabled={loading || active?.status === "paused" || active?.isArchived}>{loading ? "Sending" : "Send"}</button>
          </div>
          {active?.status === "paused" && <p className="status-note">This conversation is paused. Click Resume in the sidebar.</p>}
          {active?.isArchived && <p className="status-note">This conversation is archived. Unarchive it to continue chatting.</p>}
        </div>
      </section>
    </main>
  );
}
