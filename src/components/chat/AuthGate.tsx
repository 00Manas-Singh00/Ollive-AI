"use client";

type Props = {
  mode: "signin" | "signup";
  authName: string;
  authEmail: string;
  authPassword: string;
  error: string;
  onModeChange: (mode: "signin" | "signup") => void;
  onNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onSubmit: () => void;
};

export default function AuthGate({
  mode,
  authName,
  authEmail,
  authPassword,
  error,
  onModeChange,
  onNameChange,
  onEmailChange,
  onPasswordChange,
  onSubmit,
}: Props) {
  return (
    <main className="chat-shell">
      <section className="chat-main" style={{ justifyContent: "center", alignItems: "center" }}>
        <div className="composer" style={{ width: "100%", maxWidth: 460, display: "grid", gap: 10 }}>
          <h2>{mode === "signin" ? "Sign in" : "Create account"}</h2>
          {mode === "signup" && (
            <input placeholder="Name" value={authName} onChange={(e) => onNameChange(e.target.value)} />
          )}
          <input placeholder="Email" type="email" value={authEmail} onChange={(e) => onEmailChange(e.target.value)} />
          <input placeholder="Password" type="password" value={authPassword} onChange={(e) => onPasswordChange(e.target.value)} />
          <button className="send-btn" onClick={onSubmit}>{mode === "signin" ? "Sign in" : "Create account"}</button>
          {error && <p className="error-banner">{error}</p>}
          <button
            type="button"
            onClick={() => onModeChange(mode === "signin" ? "signup" : "signin")}
            style={{ background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}
          >
            {mode === "signin" ? "Need an account? Sign up" : "Already have an account? Sign in"}
          </button>
        </div>
      </section>
    </main>
  );
}
