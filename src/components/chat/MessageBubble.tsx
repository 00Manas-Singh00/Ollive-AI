"use client";

import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import "highlight.js/styles/github-dark.css";

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
      <pre className="code-block">
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

type Annotation = {
  id: string;
  thumbs: string | null;
  rating: number | null;
  comment: string | null;
};

function AnnotationBar({ messageId }: { messageId: string }) {
  const [annotation, setAnnotation] = useState<Annotation | null>(null);
  const [totalThumbs, setTotalThumbs] = useState<{ up: number; down: number }>({ up: 0, down: 0 });
  const [showStars, setShowStars] = useState(false);
  const [hoverRating, setHoverRating] = useState(0);
  const [showNote, setShowNote] = useState(false);
  const [noteText, setNoteText] = useState("");
  const [saving, setSaving] = useState(false);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch(`/api/messages/${messageId}/annotations`)
      .then((r) => r.json())
      .then((data: Annotation[]) => {
        if (!Array.isArray(data)) return;
        const own = data[0] ?? null;
        setAnnotation(own);
        if (own?.comment) setNoteText(own.comment);
        const up = data.filter((a) => a.thumbs === "up").length;
        const down = data.filter((a) => a.thumbs === "down").length;
        setTotalThumbs({ up, down });
      })
      .catch(() => {});
  }, [messageId]);

  async function upsert(patch: Partial<Pick<Annotation, "thumbs" | "rating" | "comment">>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/messages/${messageId}/annotations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...annotation, ...patch }),
      });
      const updated: Annotation = await res.json();
      setAnnotation(updated);
    } finally {
      setSaving(false);
    }
  }

  function handleThumb(dir: "up" | "down") {
    const next = annotation?.thumbs === dir ? null : dir;
    const prevDir = annotation?.thumbs as "up" | "down" | null;
    setTotalThumbs((t) => {
      const result = { ...t };
      if (prevDir) result[prevDir] = Math.max(0, result[prevDir] - 1);
      if (next) result[next] = result[next] + 1;
      return result;
    });
    setAnnotation((a) => ({ ...(a ?? { id: "", rating: null, comment: null }), thumbs: next } as Annotation));
    upsert({ thumbs: next ?? undefined });
  }

  function handleStar(star: number) {
    const next = annotation?.rating === star ? null : star;
    setAnnotation((a) => ({ ...(a ?? { id: "", thumbs: null, comment: null }), rating: next } as Annotation));
    upsert({ rating: next ?? undefined });
  }

  async function saveNote() {
    await upsert({ comment: noteText || undefined });
    setShowNote(false);
  }

  const thumbActive = (dir: "up" | "down") => annotation?.thumbs === dir;

  return (
    <div
      ref={barRef}
      className="annotation-bar"
      onMouseEnter={() => setShowStars(true)}
      onMouseLeave={() => { if (!annotation?.rating) setShowStars(false); }}
    >
      <div className="annotation-actions">
        <button
          className={`annot-thumb${thumbActive("up") ? " active" : ""}`}
          onClick={() => handleThumb("up")}
          disabled={saving}
          title="Helpful"
        >
          👍{totalThumbs.up > 1 ? <span className="annot-count">{totalThumbs.up}</span> : null}
        </button>
        <button
          className={`annot-thumb${thumbActive("down") ? " active" : ""}`}
          onClick={() => handleThumb("down")}
          disabled={saving}
          title="Not helpful"
        >
          👎{totalThumbs.down > 1 ? <span className="annot-count">{totalThumbs.down}</span> : null}
        </button>

        <div className={`star-row${showStars || annotation?.rating ? " visible" : ""}`}>
          {[1, 2, 3, 4, 5].map((s) => (
            <button
              key={s}
              className={`star-btn${(hoverRating || annotation?.rating || 0) >= s ? " lit" : ""}`}
              onMouseEnter={() => setHoverRating(s)}
              onMouseLeave={() => setHoverRating(0)}
              onClick={() => handleStar(s)}
              disabled={saving}
              title={`${s} star${s > 1 ? "s" : ""}`}
            >
              ★
            </button>
          ))}
        </div>

        <button
          className={`annot-note-btn${annotation?.comment ? " has-note" : ""}`}
          onClick={() => setShowNote((v) => !v)}
          title={annotation?.comment ? "Edit note" : "Add note"}
        >
          {annotation?.comment ? "✏️ note" : "+ note"}
        </button>
      </div>

      {showNote && (
        <div className="note-expand">
          <textarea
            className="note-textarea"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Add a note about this response…"
            rows={3}
            autoFocus
          />
          <div className="note-actions">
            <button className="mini-btn" onClick={saveNote} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button className="mini-btn ghost" onClick={() => setShowNote(false)}>Cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}

type Citation = {
  id: string;
  chunkId: string;
  relevanceScore: number;
  excerptStart: number;
  excerptEnd: number;
  chunkText: string;
  chunkIndex: number;
  documentId: string;
  filename: string;
};

function CitationsBar({ messageId }: { messageId: string }) {
  const [citations, setCitations] = useState<Citation[]>([]);
  const [openId, setOpenId] = useState<string | null>(null);

  useEffect(() => {
    fetch(`/api/messages/${messageId}/citations`)
      .then((r) => r.json())
      .then((data: Citation[]) => {
        if (Array.isArray(data)) setCitations(data);
      })
      .catch(() => {});
  }, [messageId]);

  if (citations.length === 0) return null;

  const open = citations.find((c) => c.id === openId) ?? null;

  return (
    <div className="citations-bar">
      <span className="citations-label">📎 Sources</span>
      {citations.map((c) => (
        <button
          key={c.id}
          className={`citation-chip${openId === c.id ? " active" : ""}`}
          onClick={() => setOpenId((id) => (id === c.id ? null : c.id))}
          title={c.filename}
        >
          {c.filename}
          <span className="citation-score">{Math.round(c.relevanceScore * 100)}%</span>
        </button>
      ))}

      {open && (
        <div className="citation-popover">
          <div className="citation-popover-head">
            <span className="citation-popover-file">{open.filename}</span>
            <span className="citation-popover-meta">chunk #{open.chunkIndex}</span>
            <button className="citation-popover-close" onClick={() => setOpenId(null)} title="Close">×</button>
          </div>
          <p className="citation-popover-text">
            {open.chunkText.slice(0, open.excerptStart)}
            <mark className="citation-excerpt">
              {open.chunkText.slice(open.excerptStart, open.excerptEnd)}
            </mark>
            {open.chunkText.slice(open.excerptEnd)}
          </p>
        </div>
      )}
    </div>
  );
}

function ThinkingPanel({ thoughts, streaming }: { thoughts: string[]; streaming?: boolean }) {
  const [open, setOpen] = useState(!!streaming);

  // Live-expanded while tokens stream in; collapses once the response is finalised.
  useEffect(() => {
    setOpen(!!streaming);
  }, [streaming]);

  if (thoughts.length === 0) return null;

  return (
    <div className={`thinking-panel${open ? " open" : ""}`}>
      <button className="thinking-toggle" onClick={() => setOpen((v) => !v)}>
        <span className="thinking-icon">{streaming ? "◌" : "🧠"}</span>
        {streaming ? "Thinking…" : `Thinking (${thoughts.length} step${thoughts.length > 1 ? "s" : ""})`}
        <span className="thinking-chevron">{open ? "▾" : "▸"}</span>
      </button>
      {open && (
        <ol className="thinking-steps">
          {thoughts.map((t, i) => (
            <li key={i} className="thinking-step">{t}</li>
          ))}
        </ol>
      )}
    </div>
  );
}

type Props = {
  messageId: string;
  role: string;
  content: string;
  thoughts?: string[];
  streaming?: boolean;
  animationDelay?: number;
  onBranch?: (messageId: string) => void;
};

export default function MessageBubble({ messageId, role, content, thoughts, streaming, animationDelay, onBranch }: Props) {
  return (
    <div
      className={`bubble-row ${role === "user" ? "user" : "assistant"}`}
      style={animationDelay !== undefined ? { animationDelay: `${animationDelay}ms` } : undefined}
    >
      {onBranch && !streaming && (
        <button className="branch-from-btn" onClick={() => onBranch(messageId)} title="Branch a new conversation from here">
          ⑂ Branch from here
        </button>
      )}
      <div className={`bubble${streaming ? " streaming" : ""}`}>
        {role === "assistant" && thoughts && <ThinkingPanel thoughts={thoughts} streaming={streaming} />}
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            code({ className, children, ...props }) {
              const inline = !(className || "").includes("language-") && String(children || "").indexOf("\n") === -1;
              if (inline) return <code {...props}>{children}</code>;
              return <CodeBlock className={className}>{children}</CodeBlock>;
            },
            blockquote({ children }) { return <div className="callout">{children}</div>; },
            a({ href, children }) { return <a href={href} target="_blank" rel="noreferrer">{children}</a>; },
          }}
        >
          {content}
        </ReactMarkdown>
        {streaming && <span className="cursor-blink">▋</span>}
      </div>
      {role === "assistant" && !streaming && (
        <>
          <CitationsBar messageId={messageId} />
          <AnnotationBar messageId={messageId} />
        </>
      )}
    </div>
  );
}
