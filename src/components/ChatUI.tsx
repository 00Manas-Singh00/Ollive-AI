"use client";

import { useEffect, useMemo, useState } from "react";
import AuthGate from "@/components/chat/AuthGate";
import ConversationSidebar from "@/components/chat/ConversationSidebar";
import MessageList from "@/components/chat/MessageList";
import ChatInput from "@/components/chat/ChatInput";

type Message = { id: string; role: string; content: string };
type Conversation = { id: string; title: string; status: string; isArchived: boolean; isPinned: boolean; folder: string | null; tags: string[]; messages: Message[] };
type UserRole = "VIEWER" | "ANALYST" | "PROMPT_EDITOR" | "ADMIN";
type User = { id: string; email: string; name: string; role?: UserRole };

async function parseJsonSafe(res: Response) {
  const t = await res.text();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}

export default function ChatUI() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [streamingContent, setStreamingContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [openNewMenu, setOpenNewMenu] = useState(false);
  const [tagDrafts, setTagDrafts] = useState<Record<string, { label: string; color: string }>>({});
  const [folders, setFolders] = useState<string[]>([]);
  const [user, setUser] = useState<User | null>(null);
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");

  async function refresh() {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (showArchived) params.set("includeArchived", "true");
    const res = await fetch(`/api/conversations?${params.toString()}`, { cache: "no-store" });
    const data = await parseJsonSafe(res);
    if (!res.ok) return setError(data?.error || `Failed (${res.status})`);
    setConversations(data?.conversations || []);
    if (!activeId && data?.conversations?.length) setActiveId(data.conversations[0].id);
  }

  useEffect(() => {
    fetch("/api/auth/me").then((r) => r.json()).then((d) => {
      setUser(d?.user || null);
      if (d?.user) refresh();
    });
  }, []);

  useEffect(() => { if (user) refresh(); }, [search, showArchived, user]);

  const active = useMemo(() => conversations.find((c) => c.id === activeId) || null, [conversations, activeId]);
  const folderNames = useMemo(
    () => Array.from(new Set([...folders, ...conversations.map((c) => c.folder?.trim()).filter((f): f is string => Boolean(f))])),
    [conversations, folders],
  );

  async function updateConversation(id: string, patch: Record<string, unknown>) {
    await fetch(`/api/conversations/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
    await refresh();
  }

  async function deleteConversation(id: string) {
    await fetch(`/api/conversations/${id}`, { method: "DELETE" });
    if (activeId === id) setActiveId(null);
    await refresh();
  }

  async function updateConversationStatus(id: string, action: "pause" | "resume") {
    await fetch(`/api/conversations/${id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    await refresh();
  }

  async function shareConversation(id: string) {
    const r = await fetch(`/api/conversations/${id}/share`, { method: "POST" });
    const d = await r.json();
    if (r.ok && d?.shareUrl) await navigator.clipboard.writeText(`${window.location.origin}${d.shareUrl}`);
  }

  async function send() {
    const text = input.trim();
    if (!text || loading || active?.status === "paused" || active?.isArchived) return;
    setLoading(true);
    setInput("");
    setStreamingContent("");
    setError("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ conversationId: activeId, message: text }),
      });

      if (!res.ok || !res.body) {
        const payload = await parseJsonSafe(res);
        setError(payload?.error || `Chat failed (${res.status})`);
        setStreamingContent(null);
        setLoading(false);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const raw = line.slice(6).trim();
          if (raw === "[DONE]") { setStreamingContent(null); await refresh(); break; }
          try {
            const event = JSON.parse(raw);
            if (event.token !== undefined) setStreamingContent((prev) => (prev ?? "") + event.token);
            if (event.done || event.moderated) {
              if (event.conversationId) setActiveId(event.conversationId);
              setStreamingContent(null);
              await refresh();
            }
            if (event.error) { setError(event.error); setStreamingContent(null); }
          } catch { /* malformed SSE line */ }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat failed");
      setStreamingContent(null);
    }

    setLoading(false);
  }

  async function signIn() {
    const res = await fetch("/api/auth/signin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: authName, email: authEmail }) });
    const data = await parseJsonSafe(res);
    if (!res.ok) return setError(data?.error || "Sign in failed");
    setUser(data.user);
    setError("");
    await refresh();
  }

  if (!user) {
    return (
      <AuthGate
        authName={authName}
        authEmail={authEmail}
        error={error}
        onNameChange={setAuthName}
        onEmailChange={setAuthEmail}
        onSignIn={signIn}
      />
    );
  }

  const displayMessages = [
    ...(active?.messages ?? []),
    ...(streamingContent !== null ? [{ id: "__streaming__", role: "assistant", content: streamingContent, streaming: true }] : []),
  ];

  return (
    <main className="chat-shell">
      <ConversationSidebar
        user={user}
        conversations={conversations}
        activeId={activeId}
        search={search}
        showArchived={showArchived}
        openMenuId={openMenuId}
        openNewMenu={openNewMenu}
        tagDrafts={tagDrafts}
        folderNames={folderNames}
        onSelectConversation={setActiveId}
        onSearchChange={setSearch}
        onToggleArchived={() => setShowArchived((v) => !v)}
        onSetOpenMenuId={setOpenMenuId}
        onSetOpenNewMenu={setOpenNewMenu}
        onNewConversation={() => { setActiveId(null); setInput(""); setOpenNewMenu(false); }}
        onNewFolder={() => {
          const name = (window.prompt("Folder name", "") || "").trim();
          if (!name) return;
          setFolders((p) => (p.includes(name) ? p : [...p, name]));
          setOpenNewMenu(false);
        }}
        onUpdateConversation={updateConversation}
        onDeleteConversation={deleteConversation}
        onUpdateStatus={updateConversationStatus}
        onSetTagDrafts={setTagDrafts}
        onShareConversation={shareConversation}
      />

      <section className="chat-main">
        <header className="chat-header">
          <h1>{active ? active.title : "Start a new conversation"}</h1>
          <p>Ask anything. Conversations are scoped to your workspace.</p>
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            <button
              className="mini-btn"
              disabled={!active}
              onClick={() => {
                if (!active) return;
                const text = active.messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n---\n\n");
                const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = `${active.title.replace(/\s+/g, "-") || "chat"}-transcript.txt`;
                a.click();
                URL.revokeObjectURL(url);
              }}
            >
              Download transcript
            </button>
            <button className="mini-btn" onClick={async () => { await fetch("/api/auth/signout", { method: "POST" }); setUser(null); }}>
              Sign out
            </button>
          </div>
        </header>

        {error && <p className="error-banner">{error}</p>}

        <div className="message-pane">
          <MessageList messages={displayMessages} />
        </div>

        <ChatInput
          value={input}
          loading={loading}
          disabled={loading || active?.status === "paused" || !!active?.isArchived}
          conversationId={activeId}
          onChange={setInput}
          onSend={send}
          onFileUploaded={() => setError("")}
        />
      </section>
    </main>
  );
}
