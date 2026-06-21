"use client";

import MessageBubble from "./MessageBubble";

type Message = { id: string; role: string; content: string; streaming?: boolean; };

type Props = {
  messages: Message[];
};

export default function MessageList({ messages }: Props) {
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
        <MessageBubble
          key={m.id}
          messageId={m.id}
          role={m.role}
          content={m.content}
          streaming={m.streaming}
          animationDelay={i * 30}
        />
      ))}
    </>
  );
}
