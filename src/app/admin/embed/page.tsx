"use client";

import { useEffect, useState, useCallback } from "react";

type EmbedToken = {
  id: string;
  token: string;
  name: string | null;
  promptProfileKey: string | null;
  allowedOrigins: string[];
  isActive: boolean;
  createdAt: string;
};

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function EmbedTokensPage() {
  const [tokens, setTokens] = useState<EmbedToken[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [promptProfileKey, setPromptProfileKey] = useState("");
  const [origins, setOrigins] = useState("");
  const [creating, setCreating] = useState(false);

  const fetchTokens = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/embed-tokens");
      if (!res.ok) throw new Error(await res.text());
      const data = await res.json();
      setTokens(data.tokens);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load tokens");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchTokens(); }, [fetchTokens]);

  async function createToken() {
    setCreating(true);
    try {
      const allowedOrigins = origins.split(",").map((o) => o.trim()).filter(Boolean);
      const res = await fetch("/api/admin/embed-tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name || undefined, promptProfileKey: promptProfileKey || undefined, allowedOrigins }),
      });
      if (!res.ok) throw new Error(await res.text());
      setName("");
      setPromptProfileKey("");
      setOrigins("");
      await fetchTokens();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create token");
    } finally {
      setCreating(false);
    }
  }

  async function toggleActive(id: string, isActive: boolean) {
    await fetch(`/api/admin/embed-tokens/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ isActive }),
    });
    await fetchTokens();
  }

  async function removeToken(id: string) {
    await fetch(`/api/admin/embed-tokens/${id}`, { method: "DELETE" });
    await fetchTokens();
  }

  if (loading) return <div style={{ padding: 32, color: "var(--muted)" }}>Loading…</div>;

  return (
    <div style={{ padding: "24px 32px", maxWidth: 1000 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>Embed Tokens</h1>
      <p style={{ color: "var(--muted)", marginBottom: 24, fontSize: 14 }}>
        Create tokens to embed the chat widget on external sites via <code>public/embed.js</code>.
      </p>

      {error && <div style={{ color: "var(--danger)", marginBottom: 16 }}>{error}</div>}

      <div style={{ display: "flex", gap: 8, marginBottom: 24, flexWrap: "wrap" }}>
        <input placeholder="Name (optional)" value={name} onChange={(e) => setName(e.target.value)}
          style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", color: "var(--text)", fontSize: 13 }} />
        <input placeholder="Prompt profile key (optional)" value={promptProfileKey} onChange={(e) => setPromptProfileKey(e.target.value)}
          style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", color: "var(--text)", fontSize: 13 }} />
        <input placeholder="Allowed origins, comma-separated (optional)" value={origins} onChange={(e) => setOrigins(e.target.value)}
          style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", color: "var(--text)", fontSize: 13, minWidth: 260 }} />
        <button onClick={createToken} disabled={creating} className="send-btn">
          {creating ? "Creating…" : "Create Token"}
        </button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["Name", "Token", "Profile Key", "Allowed Origins", "Active", "Created", ""].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "var(--muted)", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {tokens.map((t) => (
              <tr key={t.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "10px 12px", fontWeight: 500 }}>{t.name || "—"}</td>
                <td style={{ padding: "10px 12px", color: "var(--muted)", fontFamily: "monospace", fontSize: 12 }}>{t.token}</td>
                <td style={{ padding: "10px 12px", color: "var(--muted)" }}>{t.promptProfileKey || "default"}</td>
                <td style={{ padding: "10px 12px", color: "var(--muted)" }}>{t.allowedOrigins.length ? t.allowedOrigins.join(", ") : "any"}</td>
                <td style={{ padding: "10px 12px" }}>
                  <input type="checkbox" checked={t.isActive} onChange={(e) => toggleActive(t.id, e.target.checked)} />
                </td>
                <td style={{ padding: "10px 12px", color: "var(--muted)" }}>{formatDate(t.createdAt)}</td>
                <td style={{ padding: "10px 12px" }}>
                  <button onClick={() => removeToken(t.id)} className="mini-btn">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
