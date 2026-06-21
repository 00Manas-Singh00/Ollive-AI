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

type Props = {
  messageId: string;
  role: string;
  content: string;
  streaming?: boolean;
  animationDelay?: number;
};

export default function MessageBubble({ messageId, role, content, streaming, animationDelay }: Props) {
  return (
    <div
      className={`bubble-row ${role === "user" ? "user" : "assistant"}`}
      style={animationDelay !== undefined ? { animationDelay: `${animationDelay}ms` } : undefined}
    >
      <div className={`bubble${streaming ? " streaming" : ""}`}>
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
        <AnnotationBar messageId={messageId} />
      )}
    </div>
  );
}
