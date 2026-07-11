import { useState } from "react";
import type { AiVisibilityResult } from "../../../plugins/ai-visibility/result.js";

// The AI Visibility result view — reached from Skills (its own place, not a blob on
// the Skills list). You tell it about your business, it asks your brain, and shows
// what came back: a score WE compute, the verbatim answers, competitors, and fix-its.
// Every answer string is untrusted model output — React escapes it on render.

function grade(score: number): string {
  if (score >= 67) return "AI knows you well";
  if (score >= 34) return "AI sort of knows you";
  return "AI barely knows you yet";
}

export function AiVisibilityView({ onBack }: { onBack: () => void }) {
  const [name, setName] = useState("");
  const [category, setCategory] = useState("");
  const [city, setCity] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [result, setResult] = useState<AiVisibilityResult | null>(null);

  async function check() {
    setBusy(true);
    setNotice("");
    setResult(null);
    const res = await window.deskhand.plugins.run("ai-visibility", JSON.stringify({ name, category, city }));
    setBusy(false);
    if (!res.ok) {
      setNotice(res.message);
      return;
    }
    try {
      setResult(JSON.parse(res.result ?? "") as AiVisibilityResult);
    } catch {
      setNotice("Something came back we couldn't read. Try again.");
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <button className="link" onClick={onBack}>
          ← Back to Skills
        </button>
        <h1>AI Visibility</h1>
        <p>See what your assistant&apos;s brain tells customers about your business. This checks the brain you set up, not every AI everywhere.</p>
      </header>

      <div className="form">
        <label htmlFor="av-name">Your business name</label>
        <input id="av-name" type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder="Rose &amp; Thorn" />

        <label htmlFor="av-category">What kind of business?</label>
        <input id="av-category" type="text" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="florist" />

        <label htmlFor="av-city">Your town or city</label>
        <input id="av-city" type="text" value={city} onChange={(e) => setCity(e.target.value)} placeholder="Leeds" />

        <div className="row">
          <button className="primary" onClick={() => void check()} disabled={busy || name.trim().length === 0}>
            {busy ? "Asking your brain…" : "Check my visibility"}
          </button>
        </div>

        {notice.length > 0 && <p className="notice">{notice}</p>}
      </div>

      {result !== null && (
        <div className="av-result">
          <div className="card av-score">
            <p className="av-score-num">{result.score}<span>/100</span></p>
            <p className="who">{grade(result.score)}</p>
            <p className="hint">How often AI brought you up on its own — without being handed your name.</p>
          </div>

          <h2>What your brain said</h2>
          <ul className="news-list">
            {result.findings.map((f, i) => (
              <li key={i} className="card">
                <h3>{f.prompt}</h3>
                <p>{f.answer}</p>
                <p className="hint">
                  {f.scored ? (f.mentioned ? "✓ brought you up on its own" : "— didn't bring you up") : "· you asked directly (doesn't count toward the score)"}
                </p>
              </li>
            ))}
          </ul>

          <h2>Others it named</h2>
          {result.competitors.length === 0 ? (
            <p className="hint">It didn&apos;t name anyone in particular.</p>
          ) : (
            <ul className="hint">
              {result.competitors.map((c, i) => (
                <li key={i}>{c}</li>
              ))}
            </ul>
          )}

          <h2>What could help</h2>
          <ul className="hint">
            {result.fixits.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
