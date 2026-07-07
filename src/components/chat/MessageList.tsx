"use client";

import MessageBubble from "./MessageBubble";
import RacePane from "./RacePane";
import WidgetRenderer, { type WidgetInteractionData } from "./WidgetRenderer";
import type { WidgetResponse } from "@/lib/generative-ui";

type RaceResult = { id: string; provider: string; model: string; content: string; latencyMs: number; tokenCount: number | null; votedBest: boolean };
type ReasoningTrace = { steps: { index: number; text: string }[]; provider: string };
type Message = { id: string; role: string; content: string; streaming?: boolean; raceResults?: RaceResult[]; reasoningTrace?: ReasoningTrace | null; liveThoughts?: string[]; widgetInteraction?: WidgetInteractionData | null };

function messageThoughts(m: Message): string[] | undefined {
  if (m.liveThoughts) return m.liveThoughts;
  if (m.reasoningTrace?.steps?.length) return m.reasoningTrace.steps.map((s) => s.text);
  return undefined;
}

type Props = {
  messages: Message[];
  onVoteRace?: (messageId: string, raceResultId: string) => void;
  onBranch?: (messageId: string) => void;
  onWidgetRespond?: (messageId: string, response: WidgetResponse, summary: string) => void;
};

export default function MessageList({ messages, onVoteRace, onBranch, onWidgetRespond }: Props) {
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
            thoughts={messageThoughts(m)}
            streaming={m.streaming}
            animationDelay={i * 30}
            onBranch={m.streaming ? undefined : onBranch}
          />
          {m.widgetInteraction && !m.streaming && (
            <WidgetRenderer messageId={m.id} widget={m.widgetInteraction} onRespond={onWidgetRespond ?? (() => {})} />
          )}
          {m.raceResults && m.raceResults.length > 0 && (
            <RacePane messageId={m.id} raceResults={m.raceResults} onVote={onVoteRace ?? (() => {})} />
          )}
        </div>
      ))}
    </>
  );
}
