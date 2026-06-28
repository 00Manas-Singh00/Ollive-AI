"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

type RaceResult = {
  id: string;
  provider: string;
  model: string;
  content: string;
  latencyMs: number;
  tokenCount: number | null;
  votedBest: boolean;
};

type Props = {
  messageId: string;
  raceResults: RaceResult[];
  onVote: (messageId: string, raceResultId: string) => void;
};

export default function RacePane({ messageId, raceResults, onVote }: Props) {
  if (!raceResults.length) return null;

  return (
    <div className="race-pane">
      {raceResults.map((r) => (
        <div key={r.id} className={`race-card${r.votedBest ? " winner" : ""}`}>
          <div className="race-card-head">
            <span className="race-card-provider">{r.provider}</span>
            <span className="race-card-meta">{r.model} · {r.latencyMs}ms{r.tokenCount ? ` · ${r.tokenCount} tok` : ""}</span>
          </div>
          <div className="race-card-body">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {r.content}
            </ReactMarkdown>
          </div>
          <button
            className={`mini-btn${r.votedBest ? " active" : ""}`}
            onClick={() => onVote(messageId, r.id)}
          >
            {r.votedBest ? "★ Best" : "Vote best"}
          </button>
        </div>
      ))}
    </div>
  );
}
