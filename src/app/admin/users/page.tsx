"use client";

import { useEffect, useState, useCallback } from "react";

type UserRole = "VIEWER" | "ANALYST" | "PROMPT_EDITOR" | "ADMIN";

type AdminUser = {
  id: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
  totalConversations: number;
  lastActiveAt: string | null;
};

const ROLES: UserRole[] = ["VIEWER", "ANALYST", "PROMPT_EDITOR", "ADMIN"];

const ROLE_LABEL: Record<UserRole, string> = {
  VIEWER: "Viewer",
  ANALYST: "Analyst",
  PROMPT_EDITOR: "Prompt Editor",
  ADMIN: "Admin",
};

function formatDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function UsersPage() {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState<string | null>(null);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/users");
      if (!res.ok) throw new Error(await res.text());
      setUsers(await res.json());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load users");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchUsers(); }, [fetchUsers]);

  async function changeRole(userId: string, role: UserRole) {
    setSaving(userId);
    try {
      const res = await fetch(`/api/admin/users/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role }),
      });
      if (!res.ok) throw new Error(await res.text());
      setUsers((prev) => prev.map((u) => u.id === userId ? { ...u, role } : u));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update role");
    } finally {
      setSaving(null);
    }
  }

  if (loading) return <div style={{ padding: 32, color: "var(--muted)" }}>Loading…</div>;
  if (error) return <div style={{ padding: 32, color: "var(--danger)" }}>{error}</div>;

  return (
    <div style={{ padding: "24px 32px", maxWidth: 1000 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 8 }}>User Management</h1>
      <p style={{ color: "var(--muted)", marginBottom: 24, fontSize: 14 }}>
        {users.length} user{users.length !== 1 ? "s" : ""}
      </p>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border)" }}>
              {["Name", "Email", "Role", "Conversations", "Last Active", "Joined"].map((h) => (
                <th key={h} style={{ textAlign: "left", padding: "8px 12px", color: "var(--muted)", fontWeight: 600, whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderBottom: "1px solid var(--border)" }}>
                <td style={{ padding: "10px 12px", fontWeight: 500 }}>{u.name}</td>
                <td style={{ padding: "10px 12px", color: "var(--muted)" }}>{u.email}</td>
                <td style={{ padding: "10px 12px" }}>
                  <select
                    value={u.role}
                    disabled={saving === u.id}
                    onChange={(e) => changeRole(u.id, e.target.value as UserRole)}
                    style={{
                      background: "var(--surface)",
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      padding: "4px 8px",
                      color: "var(--text)",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    {ROLES.map((r) => (
                      <option key={r} value={r}>{ROLE_LABEL[r]}</option>
                    ))}
                  </select>
                </td>
                <td style={{ padding: "10px 12px", color: "var(--muted)", textAlign: "center" }}>{u.totalConversations}</td>
                <td style={{ padding: "10px 12px", color: "var(--muted)" }}>{formatDate(u.lastActiveAt)}</td>
                <td style={{ padding: "10px 12px", color: "var(--muted)" }}>{formatDate(u.createdAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
