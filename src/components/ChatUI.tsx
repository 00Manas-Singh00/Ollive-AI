"use client";

import { useEffect, useMemo, useState } from "react";
import AuthGate from "@/components/chat/AuthGate";
import ConversationSidebar from "@/components/chat/ConversationSidebar";
import MessageList from "@/components/chat/MessageList";
import ChatInput from "@/components/chat/ChatInput";
import CommandPalette, { type PaletteAction } from "@/components/chat/CommandPalette";
import ReportPanel from "@/components/chat/ReportPanel";
import ScheduleModal from "@/components/chat/ScheduleModal";

import type { WidgetInteractionData } from "@/components/chat/WidgetRenderer";
import type { WidgetResponse } from "@/lib/generative-ui";

type RaceResult = { id: string; provider: string; model: string; content: string; latencyMs: number; tokenCount: number | null; votedBest: boolean };
type ReasoningTrace = { steps: { index: number; text: string }[]; provider: string };
type Message = { id: string; role: string; content: string; raceResults?: RaceResult[]; reasoningTrace?: ReasoningTrace | null; widgetInteraction?: WidgetInteractionData | null };
type ReplayMeta = { forkedFrom: string; forkedFromTitle: string; providerOverride: string | null; promptVersionOverride: number | null };
type ConversationMember = { id: string; userId: string; role: "OWNER" | "COLLABORATOR" | "VIEWER"; user: { id: string; name: string; email: string } };
type Conversation = {
  id: string;
  title: string;
  status: string;
  isArchived: boolean;
  isPinned: boolean;
  folder: string | null;
  tags: string[];
  messages: Message[];
  replayMeta?: ReplayMeta | null;
  isCollaborative?: boolean;
  myRole?: "OWNER" | "COLLABORATOR" | "VIEWER";
  members?: ConversationMember[];
};
type PresenceEntry = { userId: string; name: string };
type UserRole = "VIEWER" | "ANALYST" | "PROMPT_EDITOR" | "ADMIN";
type User = { id: string; email: string; name: string; role?: UserRole };
type ProactiveInsight = { id: string; triggerReason: string; suggestedMessage: string; relatedConversationIds: string[]; createdAt: string };
type BudgetStatus = { status: "ok" | "warning" | "exceeded"; spendUsd: number; budgetUsd: number | null; action: "WARN" | "DOWNGRADE" | "BLOCK" };

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
  const [streamingThoughts, setStreamingThoughts] = useState<string[]>([]);
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
  const [raceMode, setRaceMode] = useState(false);
  const [raceProviders, setRaceProviders] = useState<string[]>(["gemini", "grok"]);
  const [toolsMode, setToolsMode] = useState(false);
  const [branchRefreshKey, setBranchRefreshKey] = useState(0);
  const [insights, setInsights] = useState<ProactiveInsight[]>([]);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [budget, setBudget] = useState<BudgetStatus | null>(null);
  const [downgradeNotice, setDowngradeNotice] = useState(false);
  const [reportConversationId, setReportConversationId] = useState<string | null>(null);
  const [scheduleModalOpen, setScheduleModalOpen] = useState(false);
  const [presence, setPresence] = useState<PresenceEntry[]>([]);

  async function refresh() {
    const params = new URLSearchParams();
    if (search.trim()) params.set("q", search.trim());
    if (showArchived) params.set("includeArchived", "true");
    const res = await fetch(`/api/conversations?${params.toString()}`, { cache: "no-store" });
    const data = await parseJsonSafe(res);
    if (!res.ok) return setError(data?.error || `Failed (${res.status})`);
    setConversations(data?.conversations || []);
    if (!activeId && data?.conversations?.length) setActiveId(data.conversations[0].id);
    void fetchInsights();
    void fetchBudget();
  }

  async function fetchBudget() {
    const res = await fetch("/api/budget", { cache: "no-store" });
    const data = await parseJsonSafe(res);
    if (res.ok && data?.status) setBudget(data as BudgetStatus);
  }

  async function fetchInsights() {
    const res = await fetch("/api/insights/pending", { cache: "no-store" });
    const data = await parseJsonSafe(res);
    if (res.ok && data?.insights?.length) setInsights((prev) => [...data.insights, ...prev]);
  }

  async function dismissInsight(id: string) {
    setInsights((prev) => prev.filter((i) => i.id !== id));
    await fetch(`/api/insights/${id}`, { method: "DELETE" });
  }

  function actOnInsight(insight: ProactiveInsight) {
    const related = insight.relatedConversationIds.find((cid) => conversations.some((c) => c.id === cid));
    if (related) setActiveId(related);
    setInput(insight.suggestedMessage);
    setInsights((prev) => prev.filter((i) => i.id !== insight.id));
    void fetch(`/api/insights/${insight.id}`, { method: "DELETE" });
  }

  useEffect(() => {
    fetch("/api/auth/me")
      .then(parseJsonSafe)
      .then((d) => {
        setUser(d?.user || null);
        if (d?.user) refresh();
      })
      .catch(() => setUser(null));
  }, []);

  useEffect(() => { if (user) refresh(); }, [search, showArchived, user]);

  // Phase 24: global ⌘K/Ctrl+K chord — the only key intercepted while focus is in a textarea.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const active = useMemo(() => conversations.find((c) => c.id === activeId) || null, [conversations, activeId]);

  // Phase 20: subscribe to live presence/message events for collaborative conversations only.
  useEffect(() => {
    setPresence([]);
    if (!active?.isCollaborative || !activeId) return;
    const source = new EventSource(`/api/conversations/${activeId}/events`);
    source.onmessage = (e) => {
      if (e.data === "[DONE]") return;
      try {
        const event = JSON.parse(e.data);
        if (event.type === "presence") {
          setPresence((prev) => {
            const withoutSelf = prev.filter((p) => p.userId !== event.userId);
            return [...withoutSelf, { userId: event.userId, name: event.name }];
          });
        } else if (event.type === "message_created") {
          void refresh();
        }
      } catch {
        // ignore malformed events
      }
    };
    source.onerror = () => source.close();
    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, active?.isCollaborative]);

  async function inviteCollaborator(id: string) {
    const email = (window.prompt("Invite collaborator by email", "") || "").trim();
    if (!email) return;
    const res = await fetch(`/api/conversations/${id}/members`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const data = await parseJsonSafe(res);
    if (!res.ok) return setError(data?.error || `Invite failed (${res.status})`);
    await refresh();
  }

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

  async function replayConversation(id: string) {
    setError("");
    const r = await fetch(`/api/conversations/${id}/replay`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) });
    const d = await parseJsonSafe(r);
    if (!r.ok) return setError(d?.error || `Replay failed (${r.status})`);
    await refresh();
    if (d?.conversation?.id) setActiveId(d.conversation.id);
  }

  async function branchConversation(fromMessageId: string) {
    if (!activeId) return;
    setError("");
    const r = await fetch(`/api/conversations/${activeId}/branch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fromMessageId }),
    });
    const d = await parseJsonSafe(r);
    if (!r.ok) return setError(d?.error || `Branch failed (${r.status})`);
    await refresh();
    setBranchRefreshKey((k) => k + 1);
    if (d?.conversation?.id) setActiveId(d.conversation.id);
  }

  async function send() {
    const text = input.trim();
    if (!text) return;
    setInput("");
    if (toolsMode) return sendWithTools(text);
    await sendMessage(text);
  }

  // Tool loops (Phase 18) are sync-mode only — no SSE stream, so this bypasses
  // streamingContent entirely and just waits for the final JSON response.
  async function sendWithTools(text: string) {
    if (!text || loading || active?.status === "paused" || active?.isArchived) return;
    if (budget?.status === "exceeded" && budget.action === "BLOCK") return;
    setLoading(true);
    setError("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeId, message: text, toolsEnabled: true }),
      });
      setDowngradeNotice(res.headers.get("x-budget-downgraded") === "true");
      const data = await parseJsonSafe(res);
      if (!res.ok) {
        setError(data?.error || `Chat failed (${res.status})`);
      } else {
        if (data?.conversationId) setActiveId(data.conversationId);
        await refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Chat failed");
    }

    setLoading(false);
  }

  async function sendMessage(text: string) {
    if (!text || loading || active?.status === "paused" || active?.isArchived) return;
    if (budget?.status === "exceeded" && budget.action === "BLOCK") return;
    setLoading(true);
    setStreamingContent("");
    setStreamingThoughts([]);
    setError("");

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({ conversationId: activeId, message: text }),
      });

      // Phase 22: a header on the response means this turn ran on the cheap fallback model.
      setDowngradeNotice(res.headers.get("x-budget-downgraded") === "true");

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
            if (event.thought !== undefined) setStreamingThoughts((prev) => [...prev, event.thought]);
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

  async function sendRace() {
    const text = input.trim();
    if (!text || loading || active?.status === "paused" || active?.isArchived) return;
    if (raceProviders.length < 2) return setError("Select at least 2 providers for race mode");
    setLoading(true);
    setInput("");
    setError("");

    try {
      const res = await fetch("/api/chat/race", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...(activeId ? { conversationId: activeId } : {}), content: text, providers: raceProviders }),
      });
      const data = await parseJsonSafe(res);
      if (!res.ok) setError(data?.error || `Race failed (${res.status})`);
      if (data?.conversationId) setActiveId(data.conversationId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Race failed");
    }

    setLoading(false);
  }

  function toggleRaceProvider(provider: string) {
    setRaceProviders((prev) => {
      if (prev.includes(provider)) return prev.filter((p) => p !== provider);
      if (prev.length >= 3) return prev;
      return [...prev, provider];
    });
  }

  async function respondToWidget(messageId: string, userResponse: WidgetResponse, summary: string) {
    setError("");
    const res = await fetch(`/api/messages/${messageId}/widget`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userResponse }),
    });
    if (!res.ok) {
      const data = await parseJsonSafe(res);
      return setError(data?.error || `Widget response failed (${res.status})`);
    }
    await refresh();
    // The interaction feeds back into the conversation as a synthesized user turn.
    await sendMessage(summary);
  }

  async function voteRace(messageId: string, raceResultId: string) {
    const res = await fetch(`/api/chat/race/${messageId}/vote`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ raceResultId }),
    });
    if (res.ok) await refresh();
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

  const paletteActions: PaletteAction[] = [
    { id: "new-chat", label: "New conversation", hint: "Start a fresh chat", run: () => { setActiveId(null); setInput(""); } },
    { id: "toggle-race", label: raceMode ? "Disable race mode" : "Enable race mode", hint: "Fan a prompt out to multiple providers", run: () => setRaceMode((v) => !v) },
    ...["gemini", "grok", "openai", "anthropic", "ollama"].map((p) => ({
      id: `provider-${p}`,
      label: `${raceProviders.includes(p) ? "Remove" : "Add"} race provider: ${p}`,
      hint: "Race mode provider selection",
      run: () => toggleRaceProvider(p),
    })),
    { id: "toggle-archived", label: showArchived ? "Hide archived conversations" : "Show archived conversations", run: () => setShowArchived((v) => !v) },
    { id: "scheduled-prompts", label: "Scheduled prompts", hint: "Manage recurring AI digests", run: () => setScheduleModalOpen(true) },
    ...(active
      ? [
          { id: "share", label: "Share current conversation", hint: "Copies a read-only link", run: () => void shareConversation(active.id) },
          { id: "replay", label: "Replay current conversation", hint: "Re-runs turns into a fork", run: () => void replayConversation(active.id) },
          { id: "analyze", label: "Analyze current conversation", hint: "Generates a topics/sentiment/action-items report", run: () => setReportConversationId(active.id) },
          { id: "archive", label: active.isArchived ? "Unarchive current conversation" : "Archive current conversation", run: () => void updateConversation(active.id, { isArchived: !active.isArchived }) },
        ]
      : []),
  ];

  const budgetBlocked = budget?.status === "exceeded" && budget.action === "BLOCK";

  const displayMessages = [
    ...(active?.messages ?? []),
    ...(streamingContent !== null
      ? [{ id: "__streaming__", role: "assistant", content: streamingContent, streaming: true, liveThoughts: streamingThoughts.length ? streamingThoughts : undefined }]
      : []),
  ];

  return (
    <main className="chat-shell">
      {paletteOpen && (
        <CommandPalette
          actions={paletteActions}
          conversations={conversations.map((c) => ({ id: c.id, title: c.title }))}
          onSelectConversation={setActiveId}
          onClose={() => setPaletteOpen(false)}
        />
      )}
      {reportConversationId && (
        <ReportPanel conversationId={reportConversationId} onClose={() => setReportConversationId(null)} />
      )}
      {scheduleModalOpen && <ScheduleModal onClose={() => setScheduleModalOpen(false)} />}
      <ConversationSidebar
        user={user}
        budget={budget}
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
        onReplayConversation={replayConversation}
        onAnalyzeConversation={setReportConversationId}
        onOpenSchedules={() => setScheduleModalOpen(true)}
        branchRefreshKey={branchRefreshKey}
      />

      <section className="chat-main">
        <header className="chat-header">
          <h1>{active ? active.title : "Start a new conversation"}</h1>
          {active?.replayMeta && (
            <span className="status" style={{ display: "inline-block", marginBottom: 6 }}>
              Forked from {active.replayMeta.forkedFromTitle}
            </span>
          )}
          <p>Ask anything. Conversations are scoped to your workspace.</p>
          {active?.isCollaborative && (
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6 }}>
              <span className="status">👥 Live:</span>
              {presence
                .filter((p) => p.userId !== user.id)
                .map((p) => (
                  <span key={p.userId} className="mini-btn" title={p.name} style={{ padding: "2px 8px" }}>
                    {p.name}
                  </span>
                ))}
              {!presence.some((p) => p.userId !== user.id) && <span className="status">just you</span>}
            </div>
          )}
          <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
            {active && active.myRole !== "VIEWER" && (
              <button className="mini-btn" onClick={() => inviteCollaborator(active.id)}>
                Invite collaborator
              </button>
            )}
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

        {insights.map((insight) => (
          <div key={insight.id} className="insight-banner">
            <div className="insight-banner-body">
              <span className="insight-banner-label">💡 Suggestion</span>
              <p className="insight-banner-message">{insight.suggestedMessage}</p>
              <span className="insight-banner-reason">{insight.triggerReason}</span>
            </div>
            <div className="insight-banner-actions">
              <button className="mini-btn" onClick={() => actOnInsight(insight)}>Explore</button>
              <button className="mini-btn" onClick={() => dismissInsight(insight.id)} aria-label="Dismiss">✕</button>
            </div>
          </div>
        ))}

        {budgetBlocked && (
          <p className="error-banner">
            Monthly budget reached (${budget!.spendUsd.toFixed(2)} of ${budget!.budgetUsd?.toFixed(2)}). Chat is paused until next month or until an admin raises your budget.
          </p>
        )}
        {downgradeNotice && (
          <p className="error-banner" style={{ background: "rgba(245, 158, 11, 0.15)", borderColor: "#f59e0b", color: "#f59e0b" }}>
            Budget limit reached — responses are using the cheaper fallback model.
            <button className="mini-btn" style={{ marginLeft: 8 }} onClick={() => setDowngradeNotice(false)}>✕</button>
          </p>
        )}
        {error && <p className="error-banner">{error}</p>}

        <div className="message-pane">
          <MessageList messages={displayMessages} onVoteRace={voteRace} onBranch={branchConversation} onWidgetRespond={respondToWidget} />
        </div>

        <ChatInput
          value={input}
          loading={loading}
          disabled={loading || active?.status === "paused" || !!active?.isArchived || budgetBlocked || active?.myRole === "VIEWER"}
          conversationId={activeId}
          onChange={setInput}
          onSend={raceMode ? sendRace : send}
          onFileUploaded={() => setError("")}
          raceMode={raceMode}
          raceProviders={raceProviders}
          onToggleRaceMode={() => setRaceMode((v) => !v)}
          onToggleRaceProvider={toggleRaceProvider}
          toolsEnabled={toolsMode}
          onToggleTools={() => setToolsMode((v) => !v)}
          onError={setError}
        />
      </section>
    </main>
  );
}
