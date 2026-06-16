"use client";

type Props = {
  value: string;
  loading: boolean;
  disabled: boolean;
  onChange: (v: string) => void;
  onSend: () => void;
};

export default function ChatInput({ value, loading, disabled, onChange, onSend }: Props) {
  return (
    <div className="composer-wrap">
      <div className="composer">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Message OlliveAI"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) onSend(); }}
        />
        <button className="send-btn" onClick={onSend} disabled={disabled}>
          {loading ? "Streaming…" : "Send"}
        </button>
      </div>
    </div>
  );
}
