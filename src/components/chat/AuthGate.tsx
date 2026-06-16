"use client";

type Props = {
  authName: string;
  authEmail: string;
  error: string;
  onNameChange: (v: string) => void;
  onEmailChange: (v: string) => void;
  onSignIn: () => void;
};

export default function AuthGate({ authName, authEmail, error, onNameChange, onEmailChange, onSignIn }: Props) {
  return (
    <main className="chat-shell">
      <section className="chat-main" style={{ justifyContent: "center", alignItems: "center" }}>
        <div className="composer" style={{ width: "100%", maxWidth: 460, display: "grid", gap: 10 }}>
          <h2>Sign in</h2>
          <input placeholder="Name" value={authName} onChange={(e) => onNameChange(e.target.value)} />
          <input placeholder="Email" value={authEmail} onChange={(e) => onEmailChange(e.target.value)} />
          <button className="send-btn" onClick={onSignIn}>Sign in</button>
          {error && <p className="error-banner">{error}</p>}
        </div>
      </section>
    </main>
  );
}
