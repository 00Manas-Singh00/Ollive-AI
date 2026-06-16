"use client";

import { useState } from "react";
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

type Props = {
  role: string;
  content: string;
  streaming?: boolean;
  animationDelay?: number;
};

export default function MessageBubble({ role, content, streaming, animationDelay }: Props) {
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
    </div>
  );
}
