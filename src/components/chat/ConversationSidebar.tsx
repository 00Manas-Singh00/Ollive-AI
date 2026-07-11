"use client";

import { useEffect, useState } from "react";
import BranchTree from "./BranchTree";

type SearchHit = { conversationId: string; title: string; snippet: string; score: number; messageId: string };

type Message = { id: string; role: string; content: string };
type ReplayMeta = { forkedFrom: string; forkedFromTitle: string; providerOverride: string | null; promptVersionOverride: number | null };
type Conversation = { id: string; title: string; status: string; isArchived: boolean; isPinned: boolean; folder: string | null; tags: string[]; messages: Message[]; replayMeta?: ReplayMeta | null };
type UserRole = "VIEWER" | "ANALYST" | "PROMPT_EDITOR" | "ADMIN";
type User = { id: string; email: string; name: string; role?: UserRole };
type ColorTag = { label: string; color: string };

const TAG_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];
const COLOR_TAG_RE = /^(.+)::(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))$/;

function parseColorTag(tag: string): ColorTag | null {
  const m = tag.match(COLOR_TAG_RE);
  return m ? { label: m[1], color: m[2] } : null;
}
function serializeColorTag(tag: ColorTag) { return `${tag.label}::${tag.color}`; }

// Wrap query-term occurrences in the snippet with <mark> for the search results view.
function highlightMatch(snippet: string, query: string): React.ReactNode {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  if (terms.length === 0) return snippet;
  const escaped = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const parts = snippet.split(new RegExp(`(${escaped.join("|")})`, "gi"));
  return parts.map((part, i) =>
    terms.includes(part.toLowerCase())
      ? <mark key={i} style={{ background: "rgba(245, 158, 11, 0.35)", color: "inherit", borderRadius: 2 }}>{part}</mark>
      : part,
  );
}

type BudgetStatus = { status: "ok" | "warning" | "exceeded"; spendUsd: number; budgetUsd: number | null; action: "WARN" | "DOWNGRADE" | "BLOCK" };

type Props = {
  user: User;
  budget?: BudgetStatus | null;
  conversations: Conversation[];
  activeId: string | null;
  search: string;
  showArchived: boolean;
  openMenuId: string | null;
  openNewMenu: boolean;
  tagDrafts: Record<string, { label: string; color: string }>;
  folderNames: string[];
  onSelectConversation: (id: string) => void;
  onSearchChange: (v: string) => void;
  onToggleArchived: () => void;
  onSetOpenMenuId: (id: string | null) => void;
  onSetOpenNewMenu: (v: boolean) => void;
  onNewConversation: () => void;
  onNewFolder: () => void;
  onUpdateConversation: (id: string, patch: Record<string, unknown>) => void;
  onDeleteConversation: (id: string) => void;
  onUpdateStatus: (id: string, action: "pause" | "resume") => void;
  onSetTagDrafts: (fn: (prev: Record<string, { label: string; color: string }>) => Record<string, { label: string; color: string }>) => void;
  onShareConversation: (id: string) => void;
  onReplayConversation: (id: string) => void;
  onAnalyzeConversation: (id: string) => void;
  onOpenSchedules: () => void;
  branchRefreshKey?: number;
};

function ConversationCard({
  c, activeId, openMenuId, tagDrafts,
  onSelect, onMenuToggle, onUpdate, onDelete, onUpdateStatus, onShare, onReplay, onAnalyze, onSetTagDrafts,
}: {
  c: Conversation; activeId: string | null; openMenuId: string | null;
  tagDrafts: Record<string, { label: string; color: string }>;
  onSelect: () => void; onMenuToggle: () => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onDelete: () => void; onUpdateStatus: (action: "pause" | "resume") => void;
  onShare: () => void;
  onReplay: () => void;
  onAnalyze: () => void;
  onSetTagDrafts: (fn: (prev: Record<string, { label: string; color: string }>) => Record<string, { label: string; color: string }>) => void;
}) {
  return (
    <article className={`thread-card ${c.id === activeId ? "active" : ""}`} onClick={onSelect}>
      <div className="thread-top">
        <h3>{c.title}</h3>
        <div className="thread-menu-wrap">
          <button className="menu-btn" onClick={(e) => { e.stopPropagation(); onMenuToggle(); }}>⋯</button>
          {openMenuId === c.id && (
            <div className="thread-menu" onClick={(e) => e.stopPropagation()}>
              <button className="menu-item" onClick={() => onUpdate({ isPinned: !c.isPinned })}>{c.isPinned ? "Unpin" : "Pin"}</button>
              <button className="menu-item" onClick={() => { const t = window.prompt("Rename", c.title); if (t !== null) onUpdate({ title: t }); }}>Rename</button>
              <button className="menu-item" onClick={() => onUpdate({ isArchived: !c.isArchived })}>{c.isArchived ? "Unarchive" : "Archive"}</button>
              <button className="menu-item" onClick={onShare}>Copy share link</button>
              <button className="menu-item" onClick={onReplay}>Replay</button>
              <button className="menu-item" onClick={onAnalyze}>Analyze</button>
              <button className="menu-item" onClick={() => {
                const l = (window.prompt("Label", "") || "").trim(); if (!l) return;
                const cc = tagDrafts[c.id]?.color || TAG_COLORS[0];
                const color = (window.prompt("Color", cc) || cc).trim();
                onUpdate({ tags: [...c.tags.filter((t) => t !== serializeColorTag({ label: l, color })), serializeColorTag({ label: l, color })] });
                onSetTagDrafts((p) => ({ ...p, [c.id]: { label: "", color } }));
              }}>Add Label</button>
              {c.status === "active" && <button className="menu-item" onClick={() => onUpdateStatus("pause")}>Pause</button>}
              {c.status === "paused" && <button className="menu-item" onClick={() => onUpdateStatus("resume")}>Resume</button>}
              <button className="menu-item danger" onClick={onDelete}>Delete</button>
            </div>
          )}
        </div>
      </div>
      <div className="thread-meta">
        <span className={`status ${c.status}`}>{c.status}</span>
        {c.isPinned && <span className="status"> pinned</span>}
        {c.replayMeta && <span className="status" title={c.replayMeta.forkedFromTitle}>forked from {c.replayMeta.forkedFromTitle}</span>}
      </div>
      {!!c.tags.length && (
        <div className="tag-row">
          {c.tags.map((t) => {
            const p = parseColorTag(t);
            return p
              ? <span key={t} className="color-tag"><span className="color-dot" style={{ backgroundColor: p.color }} />{p.label}</span>
              : <span key={t} className="plain-tag">#{t}</span>;
          })}
        </div>
      )}
    </article>
  );
}

export default function ConversationSidebar({
  user, budget, conversations, activeId, search, showArchived, openMenuId, openNewMenu,
  tagDrafts, folderNames,
  onSelectConversation, onSearchChange, onToggleArchived, onSetOpenMenuId,
  onSetOpenNewMenu, onNewConversation, onNewFolder,
  onUpdateConversation, onDeleteConversation, onUpdateStatus, onSetTagDrafts, onShareConversation, onReplayConversation,
  onAnalyzeConversation,
  onOpenSchedules,
  branchRefreshKey,
}: Props) {
  // Phase 16: semantic results for the current search text, fetched debounced;
  // null means "not searching" (keyword-filtered conversation list shows instead).
  const [semanticHits, setSemanticHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);

  useEffect(() => {
    const q = search.trim();
    if (!q) {
      setSemanticHits(null);
      setSearching(false);
      return;
    }
    setSearching(true);
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`, { signal: controller.signal });
        if (res.ok) {
          const data = await res.json();
          setSemanticHits(data.results ?? []);
        } else {
          setSemanticHits(null);
        }
      } catch {
        // aborted or network error — keep previous state
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);

  const cardProps = (c: Conversation) => ({
    c, activeId, openMenuId, tagDrafts,
    onSelect: () => onSelectConversation(c.id),
    onMenuToggle: () => onSetOpenMenuId(openMenuId === c.id ? null : c.id),
    onUpdate: (patch: Record<string, unknown>) => { onUpdateConversation(c.id, patch); onSetOpenMenuId(null); },
    onDelete: () => { onDeleteConversation(c.id); onSetOpenMenuId(null); },
    onUpdateStatus: (action: "pause" | "resume") => { onUpdateStatus(c.id, action); onSetOpenMenuId(null); },
    onShare: () => { onShareConversation(c.id); onSetOpenMenuId(null); },
    onReplay: () => { onReplayConversation(c.id); onSetOpenMenuId(null); },
    onAnalyze: () => { onAnalyzeConversation(c.id); onSetOpenMenuId(null); },
    onSetTagDrafts,
  });

  // Phase 22: thin usage meter — only rendered once a budget is configured.
  const budgetPct = budget?.budgetUsd ? Math.min(1, budget.spendUsd / budget.budgetUsd) : null;
  const budgetColor = budget?.status === "exceeded" ? "#ef4444" : budget?.status === "warning" ? "#f59e0b" : "#22c55e";

  return (
    <aside className="chat-sidebar">
      {budgetPct !== null && (
        <div style={{ marginBottom: 10 }} title={`$${budget!.spendUsd.toFixed(2)} of $${budget!.budgetUsd!.toFixed(2)} this month`}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.72rem", color: "var(--text-muted)", marginBottom: 3 }}>
            <span>Monthly usage</span>
            <span style={{ color: budgetColor }}>${budget!.spendUsd.toFixed(2)} / ${budget!.budgetUsd!.toFixed(2)}</span>
          </div>
          <div style={{ height: 4, borderRadius: 2, background: "rgba(255,255,255,0.08)", overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${Math.round(budgetPct * 100)}%`, background: budgetColor, borderRadius: 2, transition: "width 0.3s" }} />
          </div>
        </div>
      )}
      <div className="brand-row">
        <div>
          <p className="brand-kicker">{user.email}</p>
          <h2 className="brand-title">Conversations</h2>
        </div>
        <div className="new-menu-wrap">
          <button className="ghost-btn" onClick={() => onSetOpenNewMenu(!openNewMenu)}>New</button>
          {openNewMenu && (
            <div className="thread-menu new-menu">
              <button className="menu-item" onClick={onNewConversation}>New Chat</button>
              <button className="menu-item" onClick={onNewFolder}>New Folder</button>
            </div>
          )}
        </div>
      </div>

      <div className="search-row">
        <input
          value={search}
          onChange={(e) => onSearchChange(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onSearchChange(""); }}
          placeholder="Search"
        />
        <button className="mini-btn" onClick={onToggleArchived}>{showArchived ? "Hide archived" : "Show archived"}</button>
      </div>

      <BranchTree
        conversationId={activeId}
        activeId={activeId}
        onSelect={onSelectConversation}
        refreshKey={branchRefreshKey}
      />

      <button
        className="mini-btn"
        style={{ width: "100%", marginBottom: 8, textAlign: "left" }}
        onClick={onOpenSchedules}
      >
        ⏰ Scheduled Prompts
      </button>

      {(user.role === "ANALYST" || user.role === "PROMPT_EDITOR" || user.role === "ADMIN") && (
        <a
          href="/analytics"
          style={{
            display: "flex", alignItems: "center", gap: 8, fontSize: "0.82rem",
            color: "var(--text-muted)", textDecoration: "none", padding: "6px 8px",
            borderRadius: 6, marginBottom: 8,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.06)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "transparent"; }}
        >
          📊 Analytics
        </a>
      )}
      {(user.role === "PROMPT_EDITOR" || user.role === "ADMIN") && (
        <a
          href="/admin/prompts"
          style={{
            display: "flex", alignItems: "center", gap: 8, fontSize: "0.82rem",
            color: "var(--text-muted)", textDecoration: "none", padding: "6px 8px",
            borderRadius: 6, marginBottom: 8,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.06)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "transparent"; }}
        >
          ✏️ Prompt Studio
        </a>
      )}
      {user.role === "ADMIN" && (
        <a
          href="/admin/users"
          style={{
            display: "flex", alignItems: "center", gap: 8, fontSize: "0.82rem",
            color: "var(--text-muted)", textDecoration: "none", padding: "6px 8px",
            borderRadius: 6, marginBottom: 8,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "rgba(255,255,255,0.06)"; }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLAnchorElement).style.background = "transparent"; }}
        >
          👥 Users
        </a>
      )}

      {search.trim() && semanticHits !== null ? (
        <div className="thread-list">
          {searching && <p className="folder-name">Searching…</p>}
          {!searching && semanticHits.length === 0 && <p className="folder-name">No matches</p>}
          {semanticHits.map((hit) => (
            <article
              key={hit.conversationId}
              className={`thread-card ${hit.conversationId === activeId ? "active" : ""}`}
              onClick={() => onSelectConversation(hit.conversationId)}
            >
              <div className="thread-top">
                <h3>{hit.title}</h3>
              </div>
              <p style={{ fontSize: "0.78rem", color: "var(--text-muted)", margin: "4px 0 0" }}>
                {highlightMatch(hit.snippet, search)}
              </p>
              <div className="thread-meta">
                <span className="status">{Math.round(hit.score * 100)}% match</span>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <>
          {folderNames.map((folder) => (
            <div key={folder} className="folder-dropzone">
              <p className="folder-name">{folder}</p>
              {conversations.filter((c) => c.folder === folder).map((c) => (
                <ConversationCard key={c.id} {...cardProps(c)} />
              ))}
            </div>
          ))}

          <div className="thread-list">
            {conversations.filter((c) => !c.folder).map((c) => (
              <ConversationCard key={c.id} {...cardProps(c)} />
            ))}
          </div>
        </>
      )}

    </aside>
  );
}
