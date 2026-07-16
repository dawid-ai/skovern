import { useEffect, useState } from "react";
import type { AppInfo } from "@skovern/core";
import { Shell } from "./Shell.js";

type Phase = "loading" | "email" | "link" | "in";

// Accept either the whole magic-link URL or just the bare token.
function extractToken(input: string): string {
  const trimmed = input.trim();
  try {
    const token = new URL(trimmed).searchParams.get("token");
    if (token) return token;
  } catch {
    // not a URL — treat the input as a bare token
  }
  return trimmed;
}

export function App() {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [ogNumber, setOgNumber] = useState<number | null>(null);
  const [email, setEmail] = useState("");
  const [link, setLink] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void window.skovern.getAppInfo().then(setInfo);
    void window.skovern.account.current().then((account) => {
      if (account) {
        setOgNumber(account.ogNumber);
        setPhase("in");
      } else {
        setPhase("email");
      }
    });
  }, []);

  async function sendLink() {
    setBusy(true);
    setNotice("");
    const res = await window.skovern.account.request(email);
    setBusy(false);
    setNotice(res.message);
    if (res.ok) setPhase("link");
  }

  async function verify() {
    setBusy(true);
    setNotice("");
    const res = await window.skovern.account.verify(extractToken(link));
    setBusy(false);
    if (res.ok && typeof res.ogNumber === "number") {
      setOgNumber(res.ogNumber);
      setPhase("in");
    } else {
      setNotice(res.message);
    }
  }

  async function signOut() {
    await window.skovern.account.signOut();
    setOgNumber(null);
    setEmail("");
    setLink("");
    setNotice("");
    setPhase("email");
  }

  // Signed in → the full app shell (nav + dedicated pages).
  if (phase === "in") {
    return <Shell ogNumber={ogNumber} onSignOut={() => void signOut()} />;
  }

  // Signed out (or loading) → the centered welcome card.
  return (
    <main className="home">
      <div className="card">
        <div className="mark" aria-hidden="true">
          DH
        </div>

        {phase === "loading" && <p>starting…</p>}

        {phase === "email" && (
          <>
            <h1>Hi — I&apos;m your new desk hand.</h1>
            <p>Pop in your email and I&apos;ll send you a link to get started. No password to remember.</p>
            <div className="form">
              <label htmlFor="email">Your email</label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@yourshop.com"
              />
              <button
                className="primary"
                onClick={() => void sendLink()}
                disabled={busy || email.length === 0}
              >
                Send me a link
              </button>
            </div>
          </>
        )}

        {phase === "link" && (
          <>
            <h1>Check your email.</h1>
            <p>
              I sent a sign-in link to <strong>{email}</strong>. Paste it below to finish.
              <br />
              <span className="hint">(Just testing? Your link also shows where Skovern is running.)</span>
            </p>
            <div className="form">
              <label htmlFor="link">Paste your link</label>
              <input
                id="link"
                type="text"
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://…"
              />
              <button
                className="primary"
                onClick={() => void verify()}
                disabled={busy || link.length === 0}
              >
                Verify
              </button>
              <button className="link" onClick={() => setPhase("email")} disabled={busy}>
                Use a different email
              </button>
            </div>
          </>
        )}

        {notice.length > 0 && <p className="notice">{notice}</p>}

        <footer>
          {info === null ? "starting…" : `${info.name} v${info.version} — running locally`}
        </footer>
      </div>
    </main>
  );
}
