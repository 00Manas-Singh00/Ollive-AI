"use client";

import { useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

type Message = { id: string; role: string; content: string };
type Conversation = { id: string; title: string; status: string; isArchived: boolean; isPinned: boolean; folder: string | null; tags: string[]; messages: Message[] };
type User = { id: string; email: string; name: string };
type ColorTag = { label: string; color: string };
const TAG_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ef4444", "#a855f7", "#14b8a6"];
const COLOR_TAG_RE = /^(.+)::(#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}))$/;

function CodeBlock({ className, children }: { className?: string; children?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = String(children || "").replace(/\n$/, "");
  const lang = className?.replace("language-", "") || "text";
  return <div className="code-block-wrap"><div className="code-head"><span>{lang}</span><button className="mini-btn" onClick={async()=>{await navigator.clipboard.writeText(text);setCopied(true);setTimeout(()=>setCopied(false),1200);}}>{copied?"Copied":"Copy"}</button></div><pre className="code-block"><code className={className}>{children}</code></pre></div>;
}
function MessageContent({ message }: { message: Message }) {
  return <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]} components={{ code({className,children,...props}){ const inline=!(className||"").includes("language-")&&String(children||"").indexOf("\n")===-1; if(inline) return <code {...props}>{children}</code>; return <CodeBlock className={className}>{children}</CodeBlock>;}, blockquote({children}){return <div className="callout">{children}</div>;}, a({href,children}){return <a href={href} target="_blank" rel="noreferrer">{children}</a>;} }}>{message.content}</ReactMarkdown>;
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
  const [user, setUser] = useState<User | null>(null);
  const [authName, setAuthName] = useState("");
  const [authEmail, setAuthEmail] = useState("");

  function parseColorTag(tag: string): ColorTag | null { const m = tag.match(COLOR_TAG_RE); return m ? { label: m[1], color: m[2] } : null; }
  function serializeColorTag(tag: ColorTag) { return `${tag.label}::${tag.color}`; }
  async function parseJsonSafe(res: Response) { const t = await res.text(); if (!t) return null; try { return JSON.parse(t); } catch { return null; } }

  async function refresh() {
    const params = new URLSearchParams(); if (search.trim()) params.set("q", search.trim()); if (showArchived) params.set("includeArchived", "true");
    const res = await fetch(`/api/conversations?${params.toString()}`, { cache: "no-store" }); const data = await parseJsonSafe(res);
    if (!res.ok) return setError(data?.error || `Failed (${res.status})`);
    setConversations(data?.conversations || []);
    if (!activeId && data?.conversations?.length) setActiveId(data.conversations[0].id);
  }

  useEffect(() => { fetch("/api/auth/me").then((r) => r.json()).then((d) => { setUser(d?.user || null); if (d?.user) refresh(); }); }, []);
  useEffect(() => { if (user) refresh(); }, [search, showArchived, user]);

  const active = useMemo(() => conversations.find((c) => c.id === activeId) || null, [conversations, activeId]);
  const folderNames = useMemo(() => Array.from(new Set([...folders, ...conversations.map((c) => c.folder?.trim()).filter((f): f is string => Boolean(f))])), [conversations, folders]);

  async function updateConversation(id: string, patch: Record<string, unknown>) { await fetch(`/api/conversations/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) }); await refresh(); }
  async function deleteConversation(id: string) { await fetch(`/api/conversations/${id}`, { method: "DELETE" }); if (activeId === id) setActiveId(null); await refresh(); }
  async function updateConversationStatus(id: string, action: "pause" | "resume") { await fetch(`/api/conversations/${id}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) }); await refresh(); }

  async function send() {
    const text = input.trim(); if (!text || loading || active?.status === "paused" || active?.isArchived) return;
    setLoading(true); setInput(""); const res = await fetch("/api/chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ conversationId: activeId, message: text }) });
    const payload = await parseJsonSafe(res); if (res.ok && payload) { setActiveId(payload.conversationId); await refresh(); } else setError(payload?.error || `Chat failed (${res.status})`); setLoading(false);
  }

  function createNewFolder() { const name = (window.prompt("Folder name", "") || "").trim(); if (!name) return; setFolders((p) => (p.includes(name) ? p : [...p, name])); setOpenNewMenu(false); }
  function startNewConversation() { setActiveId(null); setInput(""); setOpenNewMenu(false); }

  async function signIn() {
    const res = await fetch("/api/auth/signin", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: authName, email: authEmail }) });
    const data = await parseJsonSafe(res); if (!res.ok) return setError(data?.error || "Sign in failed");
    setUser(data.user); setError(""); await refresh();
  }

  if (!user) return <main className="chat-shell"><section className="chat-main" style={{ justifyContent: "center", alignItems: "center" }}><div className="composer" style={{ width: "100%", maxWidth: 460, display: "grid", gap: 10 }}><h2>Sign in</h2><input placeholder="Name" value={authName} onChange={(e)=>setAuthName(e.target.value)} /><input placeholder="Email" value={authEmail} onChange={(e)=>setAuthEmail(e.target.value)} /><button className="send-btn" onClick={signIn}>Sign in</button>{error && <p className="error-banner">{error}</p>}</div></section></main>;

  return <main className="chat-shell"><aside className="chat-sidebar"><div className="brand-row"><div><p className="brand-kicker">{user.email}</p><h2 className="brand-title">Conversations</h2></div><div className="new-menu-wrap"><button className="ghost-btn" onClick={()=>setOpenNewMenu((v)=>!v)}>New</button>{openNewMenu&&<div className="thread-menu new-menu"><button className="menu-item" onClick={startNewConversation}>New Chat</button><button className="menu-item" onClick={createNewFolder}>New Folder</button></div>}</div></div><div className="search-row"><input value={search} onChange={(e)=>setSearch(e.target.value)} placeholder="Search" /><button className="mini-btn" onClick={()=>setShowArchived((v)=>!v)}>{showArchived?"Hide archived":"Show archived"}</button></div>{folderNames.map((folder)=><div key={folder} className="folder-dropzone"><p className="folder-name">{folder}</p>{conversations.filter((c)=>c.folder===folder).map((c)=><article key={c.id} className={`thread-card ${c.id===activeId?"active":""}`} onClick={()=>setActiveId(c.id)}><div className="thread-top"><h3>{c.title}</h3><div className="thread-menu-wrap"><button className="menu-btn" onClick={(e)=>{e.stopPropagation();setOpenMenuId(openMenuId===c.id?null:c.id);}}>⋯</button>{openMenuId===c.id&&<div className="thread-menu" onClick={(e)=>e.stopPropagation()}><button className="menu-item" onClick={()=>updateConversation(c.id,{isPinned:!c.isPinned})}>{c.isPinned?"Unpin":"Pin"}</button><button className="menu-item" onClick={()=>{const t=window.prompt("Rename",c.title);if(t!==null)updateConversation(c.id,{title:t});setOpenMenuId(null);}}>Rename</button><button className="menu-item" onClick={()=>{updateConversation(c.id,{isArchived:!c.isArchived});setOpenMenuId(null);}}>{c.isArchived?"Unarchive":"Archive"}</button><button className="menu-item" onClick={async()=>{const r=await fetch(`/api/conversations/${c.id}/share`,{method:"POST"});const d=await r.json();if(r.ok&&d?.shareUrl)await navigator.clipboard.writeText(`${window.location.origin}${d.shareUrl}`);setOpenMenuId(null);}}>Copy share link</button><button className="menu-item" onClick={()=>{const l=(window.prompt("Label","")||"").trim();if(!l)return;const cc=tagDrafts[c.id]?.color||TAG_COLORS[0];const color=(window.prompt("Color",cc)||cc).trim();updateConversation(c.id,{tags:[...c.tags.filter((t)=>t!==serializeColorTag({label:l,color})),serializeColorTag({label:l,color})]});setTagDrafts((p)=>({...p,[c.id]:{label:"",color}}));setOpenMenuId(null);}}>Add Label</button>{c.status==="active"&&<button className="menu-item" onClick={()=>{updateConversationStatus(c.id,"pause");setOpenMenuId(null);}}>Pause</button>}{c.status==="paused"&&<button className="menu-item" onClick={()=>{updateConversationStatus(c.id,"resume");setOpenMenuId(null);}}>Resume</button>}<button className="menu-item danger" onClick={()=>{deleteConversation(c.id);setOpenMenuId(null);}}>Delete</button></div>}</div></div><div className="thread-meta"><span className={`status ${c.status}`}>{c.status}</span>{c.isPinned&&<span className="status"> pinned</span>}</div>{!!c.tags.length&&<div className="tag-row">{c.tags.map((t)=>{const p=parseColorTag(t);return p?<span key={t} className="color-tag"><span className="color-dot" style={{backgroundColor:p.color}} />{p.label}</span>:<span key={t} className="plain-tag">#{t}</span>;})}</div>}</article>)}</div>)}<div className="thread-list">{conversations.filter((c)=>!c.folder).map((c)=><article key={c.id} className={`thread-card ${c.id===activeId?"active":""}`} onClick={()=>setActiveId(c.id)}><div className="thread-top"><h3>{c.title}</h3><div className="thread-menu-wrap"><button className="menu-btn" onClick={(e)=>{e.stopPropagation();setOpenMenuId(openMenuId===c.id?null:c.id);}}>⋯</button>{openMenuId===c.id&&<div className="thread-menu" onClick={(e)=>e.stopPropagation()}><button className="menu-item" onClick={()=>updateConversation(c.id,{isPinned:!c.isPinned})}>{c.isPinned?"Unpin":"Pin"}</button><button className="menu-item" onClick={()=>{const t=window.prompt("Rename",c.title);if(t!==null)updateConversation(c.id,{title:t});setOpenMenuId(null);}}>Rename</button><button className="menu-item" onClick={()=>{updateConversation(c.id,{isArchived:!c.isArchived});setOpenMenuId(null);}}>{c.isArchived?"Unarchive":"Archive"}</button><button className="menu-item" onClick={async()=>{const r=await fetch(`/api/conversations/${c.id}/share`,{method:"POST"});const d=await r.json();if(r.ok&&d?.shareUrl)await navigator.clipboard.writeText(`${window.location.origin}${d.shareUrl}`);setOpenMenuId(null);}}>Copy share link</button><button className="menu-item" onClick={()=>{const l=(window.prompt("Label","")||"").trim();if(!l)return;const cc=tagDrafts[c.id]?.color||TAG_COLORS[0];const color=(window.prompt("Color",cc)||cc).trim();updateConversation(c.id,{tags:[...c.tags.filter((t)=>t!==serializeColorTag({label:l,color})),serializeColorTag({label:l,color})]});setTagDrafts((p)=>({...p,[c.id]:{label:"",color}}));setOpenMenuId(null);}}>Add Label</button>{c.status==="active"&&<button className="menu-item" onClick={()=>{updateConversationStatus(c.id,"pause");setOpenMenuId(null);}}>Pause</button>}{c.status==="paused"&&<button className="menu-item" onClick={()=>{updateConversationStatus(c.id,"resume");setOpenMenuId(null);}}>Resume</button>}<button className="menu-item danger" onClick={()=>{deleteConversation(c.id);setOpenMenuId(null);}}>Delete</button></div>}</div></div></article>)}</div></aside><section className="chat-main"><header className="chat-header"><h1>{active?active.title:"Start a new conversation"}</h1><p>Ask anything. Conversations are scoped to your workspace.</p><div style={{display:"flex",gap:8,marginTop:10}}><button className="mini-btn" onClick={()=>{if(!active)return;const text=active.messages.map((m)=>`${m.role.toUpperCase()}:\n${m.content}`).join("\n\n---\n\n");const blob=new Blob([text],{type:"text/plain;charset=utf-8"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=`${active.title.replace(/\s+/g,"-")||"chat"}-transcript.txt`;a.click();URL.revokeObjectURL(url);}} disabled={!active}>Download transcript</button><button className="mini-btn" onClick={async()=>{await fetch('/api/auth/signout',{method:'POST'});setUser(null);}}>Sign out</button></div></header>{error&&<p className="error-banner">{error}</p>}<div className="message-pane">{active?.messages?.length?active.messages.map((m,i)=><div key={m.id} className={`bubble-row ${m.role==="user"?"user":"assistant"}`} style={{animationDelay:`${i*30}ms`}}><div className="bubble"><MessageContent message={m} /></div></div>):<div className="empty-state"><h3>New thread ready</h3><p>Send your first message.</p></div>}</div><div className="composer-wrap"><div className="composer"><input value={input} onChange={(e)=>setInput(e.target.value)} placeholder="Message OlliveAI" onKeyDown={(e)=>{if(e.key==="Enter")send();}} /><button className="send-btn" onClick={send} disabled={loading||active?.status==="paused"||active?.isArchived}>{loading?"Sending":"Send"}</button></div></div></section></main>;
}
