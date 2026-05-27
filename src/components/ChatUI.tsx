"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

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
type ColorTag = { label: string; color: string };
const TAG_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];
const COLOR_TAG_RE = /^(.+)::(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))$/;

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String(children || "").replace(/\n$/, "");
  const lang = className?.replace("language-", "") || "text";

  return (
    <div className="code-block-wrap">
      <div className="code-head">
        <span>{lang}</span>
        <button
          className="mini-btn"
          onClick={async () => {
            await navigator.clipboard.writeText(text);
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="code-block"><code className={className}>{children}</code></pre>
    </div>
  );
}

function MessageContent({ message }: { message: Message }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[rehypeHighlight]}
      components={{
        code({ className, children, ...props }) {
          const inline = !(className || "").includes("language-") && String(children || "").indexOf("\n") === -1;
          if (inline) return <code {...props}>{children}</code>;
          return <CodeBlock className={className}>{children}</CodeBlock>;
        },
        blockquote({ children }) {
          return <div className="callout">{children}</div>;
        },
        a({ href, children }) {
          return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
        },
      }}
    >
      {message.content}
    </ReactMarkdown>
  );
}

export default function ChatUI() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [openNewMenu, setOpenNewMenu] = useState(false);
  const [tagDrafts, setTagDrafts] = useState<Record<string, { label: string; color: string }>>({});
  const [folders, setFolders] = useState<string[]>([]);

  function parseColorTag(tag: string): ColorTag | null {
    const match = tag.match(COLOR_TAG_RE);
    if (!match) return null;
    return { label: match[1], color: match[2] };
  }

  function serializeColorTag(tag: ColorTag) {
    return `${tag.label}::${tag.color}`;
  }

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
  const folderNames = useMemo(() => {
    const fromConversations = conversations
      .map((c) => c.folder?.trim())
      .filter((f): f is string => Boolean(f));
    return Array.from(new Set([...folders, ...fromConversations]));
  }, [conversations, folders]);
  const unfiledConversations = useMemo(
    () => conversations.filter((c) => !c.folder),
    [conversations]
  );

  function onDragStartConversation(e: React.DragEvent<HTMLElement>, conversationId: string) {
    e.dataTransfer.setData("text/plain", conversationId);
    e.dataTransfer.effectAllowed = "move";
  }

  async function onDropToFolder(e: React.DragEvent<HTMLDivElement>, folder: string) {
    e.preventDefault();
    const conversationId = e.dataTransfer.getData("text/plain");
    if (!conversationId) return;
    await updateConversation(conversationId, { folder });
  }

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
    setOpenNewMenu(false);
  }

  function createNewFolder() {
    const name = (window.prompt("Folder name", "") || "").trim();
    if (!name) return;
    setFolders((prev) => (prev.includes(name) ? prev : [...prev, name]));
    setOpenNewMenu(false);
  }

  function downloadTranscript() {
    if (!active) return;
    const text = active.messages.map((m) => `${m.role.toUpperCase()}:\n${m.content}`).join("\n\n---\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${active.title.replace(/\s+/g, "-") || "chat"}-transcript.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function renderConversationCard(c: Conversation) {
    return (
      <article
        key={c.id}
        className={`thread-card ${c.id === activeId ? "active" : ""}`}
        onClick={() => setActiveId(c.id)}
        draggable
        onDragStart={(e) => onDragStartConversation(e, c.id)}
      >
        <div className="thread-top">
          <h3>{c.title}</h3>
          <div className="thread-menu-wrap">
            <button className="menu-btn" onClick={(e) => { e.stopPropagation(); setOpenMenuId((prev) => (prev === c.id ? null : c.id)); }}>
              ⋯
            </button>
            {openMenuId === c.id && (
              <div className="thread-menu" onClick={(e) => e.stopPropagation()}>
                <button className="menu-item" onClick={() => updateConversation(c.id, { isPinned: !c.isPinned })}>{c.isPinned ? "Unpin" : "Pin"}</button>
                <button className="menu-item" onClick={() => { const title = window.prompt("Rename conversation", c.title); if (title !== null) updateConversation(c.id, { title }); setOpenMenuId(null); }}>Rename</button>
                <button className="menu-item" onClick={() => { updateConversation(c.id, { isArchived: !c.isArchived }); setOpenMenuId(null); }}>{c.isArchived ? "Unarchive" : "Archive"}</button>
                <button className="menu-item" onClick={() => {
                  const labelInput = window.prompt("Label name", "");
                  const label = (labelInput || "").trim();
                  if (!label) return;
                  const currentColor = tagDrafts[c.id]?.color || TAG_COLORS[0];
                  const colorInput = window.prompt(`Label color (hex). Try: ${TAG_COLORS.join(", ")}`, currentColor);
                  const color = (colorInput || currentColor).trim();
                  const encoded = serializeColorTag({ label, color });
                  const existing = c.tags.filter((tag) => tag !== encoded);
                  updateConversation(c.id, { tags: [...existing, encoded] });
                  setTagDrafts((prev) => ({ ...prev, [c.id]: { label: "", color } }));
                  setOpenMenuId(null);
                }}>Add Label</button>
                {c.status === "active" && <button className="menu-item" onClick={() => { updateConversationStatus(c.id, "pause"); setOpenMenuId(null); }}>Pause</button>}
                {c.status === "paused" && <button className="menu-item" onClick={() => { updateConversationStatus(c.id, "resume"); setOpenMenuId(null); }}>Resume</button>}
                <button className="menu-item danger" onClick={() => { deleteConversation(c.id); setOpenMenuId(null); }}>Delete</button>
              </div>
            )}
          </div>
        </div>
        <div className="thread-meta">
          <span className={`status ${c.status}`}>{c.status}</span>
          {c.isPinned && <span className="status"> pinned</span>}
          {c.isArchived && <span className="status"> archived</span>}
        </div>
        {!!c.tags.length && (
          <div className="tag-row">
            {c.tags.map((tag) => {
              const parsed = parseColorTag(tag);
              if (!parsed) return <span key={tag} className="plain-tag">#{tag}</span>;
              return <span key={tag} className="color-tag"><span className="color-dot" style={{ backgroundColor: parsed.color }} />{parsed.label}</span>;
            })}
          </div>
        )}
      </article>
    );
  }

  return (
    <main className="chat-shell">
      <aside className="chat-sidebar">
        <div className="brand-row">
          <div>
            <p className="brand-kicker">OlliveAI</p>
            <h2 className="brand-title">Conversations</h2>
          </div>
          <div className="new-menu-wrap">
            <button className="ghost-btn" onClick={() => setOpenNewMenu((v) => !v)}>New</button>
            {openNewMenu && (
              <div className="thread-menu new-menu">
                <button className="menu-item" onClick={startNewConversation}>New Chat</button>
                <button className="menu-item" onClick={createNewFolder}>New Folder</button>
              </div>
            )}
          </div>
        </div>

        <div className="search-row">
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search title or messages" />
          <button className="mini-btn" onClick={() => setShowArchived((v) => !v)}>{showArchived ? "Hide archived" : "Show archived"}</button>
        </div>

        {!!folderNames.length && (
          <div className="folder-section">
            <p className="section-title">Folders</p>
            <div className="folder-list">
              {folderNames.map((folder) => (
                <div key={folder} className="folder-dropzone" onDragOver={(e) => e.preventDefault()} onDrop={(e) => onDropToFolder(e, folder)}>
                  <p className="folder-name">{folder}</p>
                  <div className="folder-conversations">
                    {conversations.filter((c) => c.folder === folder).map((c) => renderConversationCard(c))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="thread-list">
          {unfiledConversations.map((c) => renderConversationCard(c))}
        </div>
      </aside>

      <section className="chat-main">
        <header className="chat-header">
          <h1>{active ? active.title : "Start a new conversation"}</h1>
          <p>Ask anything. Conversations are logged with inference telemetry.</p>
          <button className="mini-btn transcript-btn" onClick={downloadTranscript} disabled={!active}>Download transcript</button>
        </header>

        {error && <p className="error-banner">{error}</p>}

        <div className="message-pane">
          {active?.messages?.length ? (
            active.messages.map((m, i) => (
              <div key={m.id} className={`bubble-row ${m.role === "user" ? "user" : "assistant"}`} style={{ animationDelay: `${i * 30}ms` }}>
                <div className="bubble"><MessageContent message={m} /></div>
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
