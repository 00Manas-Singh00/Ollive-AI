"use client";

import { useEffect, useState, useCallback } from "react";
import { diff as myersDiff, DiffOp } from "@/lib/diff";

type PromptVersion = {
  id: string;
  version: number;
  basePrompt: string;
  variantA?: string | null;
  variantB?: string | null;
  abRatioA: number;
  modelOverrides: Record<string, string> | null;
  isRollbackPoint: boolean;
  createdAt: string;
};

type PromptProfile = {
  id: string;
  key: string;
  description?: string | null;
  activeVersion: number | null;
  versions: PromptVersion[];
};

function DiffView({ oldText, newText }: { oldText: string; newText: string }) {
  const ops: DiffOp[] = myersDiff(oldText, newText);
  return (
    <pre style={{ fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0 }}>
      {ops.map((op, i) => {
        if (op.type === "equal") return <span key={i}>{op.text}</span>;
        if (op.type === "insert") return <span key={i} style={{ background: "rgba(57,201,167,0.25)", color: "var(--accent)" }}>{op.text}</span>;
        return <span key={i} style={{ background: "rgba(251,113,133,0.2)", color: "var(--danger)", textDecoration: "line-through" }}>{op.text}</span>;
      })}
    </pre>
  );
}

export default function PromptStudioPage() {
  const [profiles, setProfiles] = useState<PromptProfile[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [activeVersion, setActiveVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Editor state
  const [basePrompt, setBasePrompt] = useState("");
  const [variantA, setVariantA] = useState("");
  const [variantB, setVariantB] = useState("");
  const [abRatio, setAbRatio] = useState(50);
  const [modelOverridesJson, setModelOverridesJson] = useState("{}");
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");

  // New profile form
  const [showNewProfile, setShowNewProfile] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [newBasePrompt, setNewBasePrompt] = useState("");
  const [creatingProfile, setCreatingProfile] = useState(false);

  // Diff state
  const [diffA, setDiffA] = useState<PromptVersion | null>(null);
  const [diffB, setDiffB] = useState<PromptVersion | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  // Test panel state
  const [testMessage, setTestMessage] = useState("");
  const [testVersionId, setTestVersionId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState("");
  const [testing, setTesting] = useState(false);

  const fetchProfiles = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch("/api/admin/prompts");
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) { setError("Access denied. Admin only."); setLoading(false); return; }
        throw new Error("Failed to load profiles");
      }
      const data = await res.json();
      setProfiles(data.profiles || []);
      if (!selectedKey && data.profiles?.length > 0) setSelectedKey(data.profiles[0].key);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Error");
    } finally {
      setLoading(false);
    }
  }, [selectedKey]);

  useEffect(() => { fetchProfiles(); }, []);

  const fetchVersions = useCallback(async (key: string) => {
    const res = await fetch(`/api/admin/prompts/${key}/versions`);
    if (!res.ok) return;
    const data = await res.json();
    const sorted: PromptVersion[] = (data.versions || []).sort((a: PromptVersion, b: PromptVersion) => b.version - a.version);
    setVersions(sorted);
    setActiveVersion(data.activeVersion);
    if (sorted.length > 0) {
      const active = sorted.find(v => v.version === data.activeVersion) || sorted[0];
      loadVersionIntoEditor(active);
      setTestVersionId(active.id);
    }
    setDiffA(null); setDiffB(null); setShowDiff(false);
  }, []);

  useEffect(() => {
    if (selectedKey) fetchVersions(selectedKey);
  }, [selectedKey, fetchVersions]);

  function loadVersionIntoEditor(v: PromptVersion) {
    setBasePrompt(v.basePrompt);
    setVariantA(v.variantA || "");
    setVariantB(v.variantB || "");
    setAbRatio(v.abRatioA ?? 50);
    setModelOverridesJson(JSON.stringify(v.modelOverrides || {}, null, 2));
  }

  async function handleSaveVersion() {
    if (!selectedKey) return;
    let modelOverrides: Record<string, string> = {};
    try { modelOverrides = JSON.parse(modelOverridesJson); } catch { setSaveMsg("Invalid JSON in model overrides"); return; }
    setSaving(true); setSaveMsg("");
    try {
      const res = await fetch(`/api/admin/prompts/${selectedKey}/versions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ basePrompt, variantA: variantA || undefined, variantB: variantB || undefined, abRatioA: abRatio, modelOverrides }),
      });
      if (!res.ok) { setSaveMsg("Failed to save version"); return; }
      setSaveMsg("Saved as new version");
      fetchVersions(selectedKey);
    } finally {
      setSaving(false);
    }
  }

  async function handleActivate(version: number) {
    if (!selectedKey) return;
    const res = await fetch(`/api/admin/prompts/${selectedKey}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ version }),
    });
    if (res.ok) fetchVersions(selectedKey);
  }

  async function handleRollback() {
    if (!selectedKey) return;
    const res = await fetch(`/api/admin/prompts/${selectedKey}/rollback`, { method: "POST" });
    if (res.ok) fetchVersions(selectedKey);
  }

  async function handleCreateProfile() {
    if (!newKey || !newBasePrompt) return;
    setCreatingProfile(true);
    try {
      const res = await fetch("/api/admin/prompts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: newKey, description: newDesc || undefined, basePrompt: newBasePrompt }),
      });
      if (!res.ok) { const d = await res.json(); alert(d.error || "Failed"); return; }
      setShowNewProfile(false); setNewKey(""); setNewDesc(""); setNewBasePrompt("");
      await fetchProfiles();
      setSelectedKey(newKey);
    } finally {
      setCreatingProfile(false);
    }
  }

  function toggleDiffSelect(v: PromptVersion) {
    if (diffA?.id === v.id) { setDiffA(null); return; }
    if (diffB?.id === v.id) { setDiffB(null); return; }
    if (!diffA) { setDiffA(v); return; }
    if (!diffB) { setDiffB(v); setShowDiff(true); return; }
    setDiffA(v); setDiffB(null); setShowDiff(false);
  }

  async function handleTest() {
    if (!testMessage.trim()) return;
    const selectedVersion = versions.find(v => v.id === testVersionId);
    setTesting(true); setTestResult("");
    try {
      // Create a temp conversation for the test
      const convRes = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: testMessage, promptVersionOverride: selectedVersion?.version }),
      });
      if (!convRes.ok) { setTestResult("Error calling chat API"); return; }
      const data = await convRes.json();
      setTestResult(data.message?.content || "No response");
    } finally {
      setTesting(false);
    }
  }

  if (loading) return <div style={{ padding: 32, color: "var(--muted)" }}>Loading...</div>;
  if (error) return <div style={{ padding: 32, color: "var(--danger)" }}>{error}</div>;

  const selectedProfile = profiles.find(p => p.key === selectedKey);

  return (
    <div style={{ display: "flex", height: "100vh", background: "var(--bg)", color: "var(--text)", fontFamily: "inherit" }}>
      {/* Sidebar */}
      <div style={{ width: 240, borderRight: "1px solid var(--line)", padding: "16px 0", display: "flex", flexDirection: "column", gap: 0, flexShrink: 0 }}>
        <div style={{ padding: "0 16px 12px", borderBottom: "1px solid var(--line)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 600, fontSize: 14 }}>Prompt Studio</span>
          <button onClick={() => setShowNewProfile(true)} style={{ background: "var(--accent)", color: "#000", border: "none", borderRadius: 4, padding: "4px 8px", fontSize: 12, cursor: "pointer" }}>+ New</button>
        </div>
        {profiles.map(p => (
          <div
            key={p.key}
            onClick={() => setSelectedKey(p.key)}
            style={{ padding: "10px 16px", cursor: "pointer", background: selectedKey === p.key ? "var(--panel-strong)" : "transparent", borderLeft: selectedKey === p.key ? "2px solid var(--accent)" : "2px solid transparent", display: "flex", alignItems: "center", gap: 8 }}
          >
            <span style={{ fontSize: 8, color: p.activeVersion ? "var(--accent)" : "var(--muted)" }}>●</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500 }}>{p.key}</div>
              {p.description && <div style={{ fontSize: 11, color: "var(--muted)" }}>{p.description}</div>}
            </div>
          </div>
        ))}

        {showNewProfile && (
          <div style={{ padding: 12, borderTop: "1px solid var(--line)", display: "flex", flexDirection: "column", gap: 8 }}>
            <input placeholder="profile-key" value={newKey} onChange={e => setNewKey(e.target.value)} style={inputStyle} />
            <input placeholder="Description (optional)" value={newDesc} onChange={e => setNewDesc(e.target.value)} style={inputStyle} />
            <textarea placeholder="Base prompt" value={newBasePrompt} onChange={e => setNewBasePrompt(e.target.value)} rows={3} style={{ ...inputStyle, resize: "vertical" }} />
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={handleCreateProfile} disabled={creatingProfile} style={btnPrimary}>{creatingProfile ? "Creating..." : "Create"}</button>
              <button onClick={() => setShowNewProfile(false)} style={btnSecondary}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      {/* Main area */}
      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column" }}>
        {!selectedProfile ? (
          <div style={{ padding: 32, color: "var(--muted)" }}>Select or create a profile</div>
        ) : (
          <>
            {/* Header */}
            <div style={{ padding: "16px 24px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontWeight: 600, fontSize: 16 }}>{selectedProfile.key}</span>
              {selectedProfile.description && <span style={{ color: "var(--muted)", fontSize: 13 }}>{selectedProfile.description}</span>}
              <span style={{ marginLeft: "auto", fontSize: 12, color: "var(--muted)" }}>Active: v{activeVersion ?? "—"}</span>
              <button onClick={handleRollback} style={btnSecondary}>Rollback to checkpoint</button>
            </div>

            <div style={{ display: "flex", flex: 1, overflow: "hidden" }}>
              {/* Editor */}
              <div style={{ flex: 1, overflow: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 16 }}>
                <div>
                  <label style={labelStyle}>Base Prompt</label>
                  <textarea value={basePrompt} onChange={e => setBasePrompt(e.target.value)} rows={6} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                  <div>
                    <label style={labelStyle}>Variant A (optional)</label>
                    <textarea value={variantA} onChange={e => setVariantA(e.target.value)} rows={4} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
                  </div>
                  <div>
                    <label style={labelStyle}>Variant B (optional)</label>
                    <textarea value={variantB} onChange={e => setVariantB(e.target.value)} rows={4} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
                  </div>
                </div>
                <div>
                  <label style={labelStyle}>A/B Ratio — A: {abRatio}% / B: {100 - abRatio}%</label>
                  <input type="range" min={0} max={100} value={abRatio} onChange={e => setAbRatio(Number(e.target.value))} style={{ width: "100%", accentColor: "var(--accent)" }} />
                </div>
                <div>
                  <label style={labelStyle}>Model Overrides (JSON)</label>
                  <textarea value={modelOverridesJson} onChange={e => setModelOverridesJson(e.target.value)} rows={3} style={{ ...inputStyle, width: "100%", fontFamily: "monospace", resize: "vertical" }} />
                </div>
                <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                  <button onClick={handleSaveVersion} disabled={saving} style={btnPrimary}>{saving ? "Saving..." : "Save as new version"}</button>
                  {saveMsg && <span style={{ fontSize: 12, color: "var(--accent)" }}>{saveMsg}</span>}
                </div>

                {/* Test panel */}
                <div style={{ borderTop: "1px solid var(--line)", paddingTop: 16, display: "flex", flexDirection: "column", gap: 10 }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>Test prompt</div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <label style={{ ...labelStyle, marginBottom: 0 }}>Version:</label>
                    <select value={testVersionId || ""} onChange={e => setTestVersionId(e.target.value)} style={{ ...inputStyle, flex: "0 0 auto" }}>
                      {versions.map(v => <option key={v.id} value={v.id}>v{v.version}{v.version === activeVersion ? " (active)" : ""}</option>)}
                    </select>
                  </div>
                  <textarea placeholder="Type a test message…" value={testMessage} onChange={e => setTestMessage(e.target.value)} rows={2} style={{ ...inputStyle, width: "100%", resize: "vertical" }} />
                  <button onClick={handleTest} disabled={testing || !testMessage.trim()} style={btnPrimary}>{testing ? "Running…" : "Run"}</button>
                  {testResult && (
                    <div style={{ background: "var(--panel-strong)", borderRadius: 6, padding: 12, fontSize: 13, whiteSpace: "pre-wrap" }}>
                      {testResult}
                    </div>
                  )}
                </div>
              </div>

              {/* Version history */}
              <div style={{ width: 280, borderLeft: "1px solid var(--line)", overflow: "auto", padding: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 12 }}>Version history</div>
                {versions.length === 0 && <div style={{ color: "var(--muted)", fontSize: 12 }}>No versions</div>}
                {versions.map(v => (
                  <div
                    key={v.id}
                    style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "8px 10px", marginBottom: 8, background: "var(--panel)", fontSize: 12 }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontWeight: 600 }}>v{v.version} {v.version === activeVersion && <span style={{ color: "var(--accent)", fontWeight: 400 }}>(active)</span>} {v.isRollbackPoint && <span style={{ color: "var(--muted)" }}>✓</span>}</span>
                      <span style={{ color: "var(--muted)", fontSize: 10 }}>{new Date(v.createdAt).toLocaleDateString()}</span>
                    </div>
                    <div style={{ color: "var(--muted)", marginBottom: 6, fontSize: 11, maxHeight: 40, overflow: "hidden" }}>{v.basePrompt.slice(0, 80)}…</div>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      <button onClick={() => loadVersionIntoEditor(v)} style={btnMini}>Load</button>
                      {v.version !== activeVersion && (
                        <button onClick={() => handleActivate(v.version)} style={{ ...btnMini, color: "var(--accent)", borderColor: "var(--accent)" }}>Activate</button>
                      )}
                      <button
                        onClick={() => toggleDiffSelect(v)}
                        style={{ ...btnMini, background: (diffA?.id === v.id || diffB?.id === v.id) ? "var(--accent)" : "transparent", color: (diffA?.id === v.id || diffB?.id === v.id) ? "#000" : "var(--muted)" }}
                      >
                        {diffA?.id === v.id ? "Diff A" : diffB?.id === v.id ? "Diff B" : "Diff"}
                      </button>
                    </div>
                  </div>
                ))}
                {diffA && !diffB && <div style={{ fontSize: 11, color: "var(--muted)", marginTop: 4 }}>Select another version to compare</div>}
              </div>
            </div>

            {/* Diff panel */}
            {showDiff && diffA && diffB && (
              <div style={{ borderTop: "1px solid var(--line)", padding: 16, background: "var(--panel)" }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                  <span style={{ fontWeight: 600, fontSize: 13 }}>Diff: v{diffA.version} → v{diffB.version}</span>
                  <button onClick={() => { setShowDiff(false); setDiffA(null); setDiffB(null); }} style={btnSecondary}>Close</button>
                </div>
                <div style={{ background: "var(--bg)", borderRadius: 6, padding: 12, maxHeight: 240, overflow: "auto" }}>
                  <DiffView oldText={diffA.basePrompt} newText={diffB.basePrompt} />
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  background: "var(--panel-strong)",
  border: "1px solid var(--line)",
  borderRadius: 4,
  color: "var(--text)",
  padding: "6px 8px",
  fontSize: 13,
  outline: "none",
  width: "100%",
  boxSizing: "border-box",
};

const btnPrimary: React.CSSProperties = {
  background: "var(--accent)",
  color: "#000",
  border: "none",
  borderRadius: 4,
  padding: "6px 14px",
  fontSize: 12,
  cursor: "pointer",
  fontWeight: 600,
};

const btnSecondary: React.CSSProperties = {
  background: "transparent",
  color: "var(--muted)",
  border: "1px solid var(--line)",
  borderRadius: 4,
  padding: "5px 12px",
  fontSize: 12,
  cursor: "pointer",
};

const btnMini: React.CSSProperties = {
  background: "transparent",
  color: "var(--muted)",
  border: "1px solid var(--line)",
  borderRadius: 3,
  padding: "2px 8px",
  fontSize: 11,
  cursor: "pointer",
};

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 11,
  color: "var(--muted)",
  marginBottom: 4,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
};
