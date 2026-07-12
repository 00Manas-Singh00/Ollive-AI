"use client";

import { useRef, useState } from "react";

type Props = {
  value: string;
  loading: boolean;
  disabled: boolean;
  conversationId: string | null;
  onChange: (v: string) => void;
  onSend: () => void;
  onFileUploaded?: (documentId: string, filename: string) => void;
  raceMode?: boolean;
  raceProviders?: string[];
  raceProviderOptions?: string[];
  onToggleRaceMode?: () => void;
  onToggleRaceProvider?: (provider: string) => void;
  toolsEnabled?: boolean;
  onToggleTools?: () => void;
  onError?: (message: string) => void;
};

export default function ChatInput({
  value,
  loading,
  disabled,
  conversationId,
  onChange,
  onSend,
  onFileUploaded,
  raceMode = false,
  raceProviders = [],
  raceProviderOptions = [],
  onToggleRaceMode,
  onToggleRaceProvider,
  toolsEnabled = false,
  onToggleTools,
  onError,
}: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  function pickMimeType(): string {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
    for (const c of candidates) {
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(c)) return c;
    }
    return "";
  }

  async function startRecording() {
    if (recording || transcribing) return;
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      onError?.(err instanceof Error ? err.message : "Microphone access denied");
      return;
    }
    const mimeType = pickMimeType();
    const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    chunksRef.current = [];

    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };

    recorder.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      chunksRef.current = [];
      setTranscribing(true);
      try {
        const formData = new FormData();
        formData.append("audio", blob, "recording.webm");
        if (conversationId) formData.append("conversationId", conversationId);
        const res = await fetch("/api/speech/transcribe", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) {
          onError?.(data?.error || `Transcription failed (${res.status})`);
        } else if (data.text) {
          // Transcription only populates the composer — the user reviews and edits before sending.
          onChange(value ? `${value} ${data.text}` : data.text);
        }
      } catch (err) {
        onError?.(err instanceof Error ? err.message : "Transcription failed");
      } finally {
        setTranscribing(false);
      }
    };

    recorder.start();
    mediaRecorderRef.current = recorder;
    setRecording(true);
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file || !conversationId) return;
    e.target.value = "";

    const formData = new FormData();
    formData.append("file", file);

    const res = await fetch(`/api/conversations/${conversationId}/documents`, {
      method: "POST",
      body: formData,
    });
    const data = await res.json();
    if (res.ok && data.documentId) {
      onFileUploaded?.(data.documentId, file.name);
    }
  }

  return (
    <div className="composer-wrap">
      {onToggleRaceMode && (
        <div className="race-toolbar">
          <button
            className={`mini-btn${raceMode ? " active" : ""}`}
            onClick={onToggleRaceMode}
            title="Fan this prompt out to multiple providers side-by-side"
          >
            🏁 Race mode
          </button>
          {raceMode && (
            <div className="race-provider-picker">
              {raceProviderOptions.map((p) => (
                <button
                  key={p}
                  type="button"
                  className={`race-chip${raceProviders.includes(p) ? " selected" : ""}`}
                  onClick={() => onToggleRaceProvider?.(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {onToggleTools && (
        <div className="race-toolbar">
          <button
            className={`mini-btn${toolsEnabled ? " active" : ""}`}
            onClick={onToggleTools}
            title="Let the assistant call tools (calculator, current time, knowledge search, conversation summary)"
          >
            🛠 Tools
          </button>
        </div>
      )}
      <div className="composer">
        <button
          className="mini-btn"
          title="Attach file"
          disabled={!conversationId}
          onClick={() => fileRef.current?.click()}
          style={{ fontSize: 18, padding: "0 8px" }}
        >
          📎
        </button>
        <input ref={fileRef} type="file" accept=".txt,.md,.csv,.json" style={{ display: "none" }} onChange={handleFile} />
        <button
          className={`mini-btn${recording ? " active" : ""}`}
          title={recording ? "Stop recording" : "Push to talk"}
          disabled={transcribing}
          onClick={() => (recording ? stopRecording() : startRecording())}
          style={{ fontSize: 18, padding: "0 8px" }}
        >
          {transcribing ? "…" : recording ? "⏹" : "🎙"}
        </button>
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Message OlliveAI"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) onSend(); }}
        />
        <button className="send-btn" onClick={onSend} disabled={disabled}>
          {loading ? "Streaming…" : raceMode ? "Race" : "Send"}
        </button>
      </div>
    </div>
  );
}
