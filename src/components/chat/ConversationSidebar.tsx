"use client";

type Message = { id: string; role: string; content: string };
type Conversation = { id: string; title: string; status: string; isArchived: boolean; isPinned: boolean; folder: string | null; tags: string[]; messages: Message[] };
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

type Props = {
  user: User;
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
};

function ConversationCard({
  c, activeId, openMenuId, tagDrafts,
  onSelect, onMenuToggle, onUpdate, onDelete, onUpdateStatus, onShare, onSetTagDrafts,
}: {
  c: Conversation; activeId: string | null; openMenuId: string | null;
  tagDrafts: Record<string, { label: string; color: string }>;
  onSelect: () => void; onMenuToggle: () => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onDelete: () => void; onUpdateStatus: (action: "pause" | "resume") => void;
  onShare: () => void;
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
  user, conversations, activeId, search, showArchived, openMenuId, openNewMenu,
  tagDrafts, folderNames,
  onSelectConversation, onSearchChange, onToggleArchived, onSetOpenMenuId,
  onSetOpenNewMenu, onNewConversation, onNewFolder,
  onUpdateConversation, onDeleteConversation, onUpdateStatus, onSetTagDrafts, onShareConversation,
}: Props) {
  const cardProps = (c: Conversation) => ({
    c, activeId, openMenuId, tagDrafts,
    onSelect: () => onSelectConversation(c.id),
    onMenuToggle: () => onSetOpenMenuId(openMenuId === c.id ? null : c.id),
    onUpdate: (patch: Record<string, unknown>) => { onUpdateConversation(c.id, patch); onSetOpenMenuId(null); },
    onDelete: () => { onDeleteConversation(c.id); onSetOpenMenuId(null); },
    onUpdateStatus: (action: "pause" | "resume") => { onUpdateStatus(c.id, action); onSetOpenMenuId(null); },
    onShare: () => { onShareConversation(c.id); onSetOpenMenuId(null); },
    onSetTagDrafts,
  });

  return (
    <aside className="chat-sidebar">
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
        <input value={search} onChange={(e) => onSearchChange(e.target.value)} placeholder="Search" />
        <button className="mini-btn" onClick={onToggleArchived}>{showArchived ? "Hide archived" : "Show archived"}</button>
      </div>

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

    </aside>
  );
}
