"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fuzzyFilter } from "@/lib/fuzzy";

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
};

type PaletteConversation = { id: string; title: string };

type SemanticHit = {
  conversationId: string;
  title: string;
  snippet: string;
  score: number;
};

type PaletteItem =
  | { kind: "action"; id: string; label: string; hint?: string; run: () => void }
  | { kind: "conversation"; id: string; label: string }
  | { kind: "semantic"; id: string; label: string; snippet: string };

type Props = {
  actions: PaletteAction[];
  conversations: PaletteConversation[];
  onSelectConversation: (id: string) => void;
  onClose: () => void;
};

function highlight(label: string, indices: number[]) {
  if (!indices.length) return label;
  const set = new Set(indices);
  return label.split("").map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : ch));
}

export default function CommandPalette({ actions, conversations, onSelectConversation, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [semanticHits, setSemanticHits] = useState<SemanticHit[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Focus trap: focus the input on open, restore the previously focused element on close.
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    inputRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const mode = query.startsWith(">") ? "actions" : query.startsWith("#") ? "conversations" : "all";
  const term = mode === "all" ? query.trim() : query.slice(1).trim();

  const actionResults = useMemo(
    () => (mode === "conversations" ? [] : fuzzyFilter(term, actions, (a) => a.label)),
    [mode, term, actions],
  );
  const conversationResults = useMemo(
    () => (mode === "actions" ? [] : fuzzyFilter(term, conversations, (c) => c.title)),
    [mode, term, conversations],
  );

  // Async semantic search section (Phase 16) — degrades gracefully when the route fails.
  useEffect(() => {
    if (mode !== "all" || term.length < 3) return setSemanticHits([]);
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(term)}&limit=5`, { cache: "no-store" });
        if (!res.ok) return setSemanticHits([]);
        const data = await res.json();
        setSemanticHits(data?.results ?? []);
      } catch {
        setSemanticHits([]);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [mode, term]);

  const items: PaletteItem[] = useMemo(() => {
    const titleMatched = new Set(conversationResults.map((r) => r.item.id));
    return [
      ...actionResults.map((r) => ({ kind: "action" as const, ...r.item })),
      ...conversationResults.map((r) => ({ kind: "conversation" as const, id: r.item.id, label: r.item.title })),
      ...semanticHits
        .filter((h) => !titleMatched.has(h.conversationId))
        .map((h) => ({ kind: "semantic" as const, id: h.conversationId, label: h.title, snippet: h.snippet })),
    ];
  }, [actionResults, conversationResults, semanticHits]);

  const indicesFor = (item: PaletteItem): number[] => {
    if (item.kind === "action") return actionResults.find((r) => r.item.id === item.id)?.indices ?? [];
    if (item.kind === "conversation") return conversationResults.find((r) => r.item.id === item.id)?.indices ?? [];
    return [];
  };

  useEffect(() => setSelected(0), [query, items.length]);
  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${selected}"]`)?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  function execute(item: PaletteItem) {
    onClose();
    if (item.kind === "action") item.run();
    else onSelectConversation(item.id);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") { e.preventDefault(); onClose(); }
    else if (e.key === "ArrowDown") { e.preventDefault(); setSelected((s) => Math.min(s + 1, items.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSelected((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); if (items[selected]) execute(items[selected]); }
    else if (e.key === "Tab") e.preventDefault(); // trap focus inside the modal
  }

  let sectionShown: PaletteItem["kind"] | null = null;
  const sectionLabel: Record<PaletteItem["kind"], string> = {
    action: "Actions",
    conversation: "Conversations",
    semantic: "Semantic matches",
  };

  return (
    <div className="palette-overlay" onMouseDown={onClose} role="presentation">
      <div className="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <input
          ref={inputRef}
          className="palette-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a command…  (> actions, # conversations)"
          aria-label="Search commands and conversations"
        />
        <div className="palette-list" ref={listRef} role="listbox">
          {items.length === 0 && <p className="palette-empty">No matches</p>}
          {items.map((item, i) => {
            const header = item.kind !== sectionShown ? sectionLabel[(sectionShown = item.kind)] : null;
            return (
              <div key={`${item.kind}:${item.id}`}>
                {header && <div className="palette-section">{header}</div>}
                <button
                  type="button"
                  data-index={i}
                  role="option"
                  aria-selected={i === selected}
                  className={`palette-item${i === selected ? " selected" : ""}`}
                  onMouseEnter={() => setSelected(i)}
                  onClick={() => execute(item)}
                >
                  <span className="palette-item-label">{highlight(item.label, indicesFor(item))}</span>
                  {item.kind === "action" && item.hint && <span className="palette-item-hint">{item.hint}</span>}
                  {item.kind === "semantic" && <span className="palette-item-snippet">{item.snippet}</span>}
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
