import { prisma } from "@/lib/prisma";

export default async function SharedPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const conversation = await prisma.conversation.findUnique({
    where: { shareToken: token },
    include: { messages: { orderBy: { createdAt: "asc" } } },
  });

  if (!conversation) return <main style={{ padding: 24, color: "#eee" }}><h1>Shared conversation not found</h1></main>;

  return (
    <main style={{ padding: 24, color: "#eee", maxWidth: 900, margin: "0 auto" }}>
      <h1>{conversation.title}</h1>
      <p>Read-only shared conversation</p>
      <div style={{ display: "grid", gap: 10 }}>
        {conversation.messages.map((m) => (
          <div key={m.id} style={{ padding: 12, border: "1px solid #334", borderRadius: 10, background: m.role === "user" ? "#144" : "#1b2a36" }}>
            <strong>{m.role}</strong>
            <p style={{ marginBottom: 0, whiteSpace: "pre-wrap" }}>{m.content}</p>
          </div>
        ))}
      </div>
    </main>
  );
}
