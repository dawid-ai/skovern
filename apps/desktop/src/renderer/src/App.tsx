import { useEffect, useState } from "react";
import type { AppInfo } from "@deskhand/core";

type Phase = "loading" | "email" | "link" | "in";

// Accept either the whole magic-link URL or just the bare token.
function extractToken(input: string): string {
  const trimmed = input.trim();
  const at = trimmed.indexOf("token=");
  if (at === -1) return trimmed;
  const after = trimmed.slice(at + "token=".length);
  return decodeURIComponent(after.split("&")[0] ?? "");
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
    void window.deskhand.getAppInfo().then(setInfo);
    void window.deskhand.account.current().then((account) => {
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
    const res = await window.deskhand.account.request(email);
    setBusy(false);
    setNotice(res.message);
    if (res.ok) setPhase("link");
  }

  async function verify() {
    setBusy(true);
    setNotice("");
    const res = await window.deskhand.account.verify(extractToken(link));
    setBusy(false);
    if (res.ok && typeof res.ogNumber === "number") {
      setOgNumber(res.ogNumber);
      setPhase("in");
    } else {
      setNotice(res.message);
    }
  }

  async function signOut() {
    await window.deskhand.account.signOut();
    setOgNumber(null);
    setEmail("");
    setLink("");
    setNotice("");
    setPhase("email");
  }

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
              <span className="hint">(Running it yourself? Copy the link from the server window.)</span>
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

        {phase === "in" && (
          <>
            <h1>You&apos;re founding user #{ogNumber}. Nice.</h1>
            <p>You&apos;re signed in. Your work stays on this computer unless you say otherwise.</p>
            <div className="actions">
              <button disabled>
                Check how AI sees my business <span>coming soon</span>
              </button>
              <button disabled>
                Watch my competitors <span>coming soon</span>
              </button>
            </div>
            <button className="link" onClick={() => void signOut()}>
              Sign out
            </button>
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
