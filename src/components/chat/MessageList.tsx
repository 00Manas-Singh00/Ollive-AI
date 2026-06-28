"use client";

import MessageBubble from "./MessageBubble";
import RacePane from "./RacePane";

type RaceResult = { id: string; provider: string; model: string; content: string; latencyMs: number; tokenCount: number | null; votedBest: boolean };
type Message = { id: string; role: string; content: string; streaming?: boolean; raceResults?: RaceResult[] };

type Props = {
  messages: Message[];
  onVoteRace?: (messageId: string, raceResultId: string) => void;
};

export default function MessageList({ messages, onVoteRace }: Props) {
  if (!messages.length) {
    return (
      <div className="empty-state">
        <h3>New thread ready</h3>
        <p>Send your first message.</p>
      </div>
    );
  }

  return (
    <>
      {messages.map((m, i) => (
        <div key={m.id}>
          <MessageBubble
            messageId={m.id}
            role={m.role}
            content={m.content}
            streaming={m.streaming}
            animationDelay={i * 30}
          />
          {m.raceResults && m.raceResults.length > 0 && (
            <RacePane messageId={m.id} raceResults={m.raceResults} onVote={onVoteRace ?? (() => {})} />
          )}
        </div>
      ))}
    </>
  );
}
