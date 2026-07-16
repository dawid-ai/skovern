import { useEffect, useRef, useState } from "react";
import type { AiVisibilityResult } from "../../../plugins/ai-visibility/result.js";
import { Answer } from "../components/Answer.js";

// The AI Visibility result view — reached from Skills (its own place, not a blob on
// the Skills list). You tell it about your business, it asks your brain, and shows
// what came back: a score WE compute, the verbatim answers, competitors, and fix-its.
// Every answer string is untrusted model output — the <Answer> component renders it
// as markdown at react-markdown's SAFE default (no raw HTML, dangerous link
// protocols dropped), so formatting shows but nothing can inject.

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
  const [publishBusy, setPublishBusy] = useState(false);
  const [published, setPublished] = useState<{ url?: string; message: string } | null>(null);
  const [progress, setProgress] = useState<{ step: number; total: number } | null>(null);
  // Hold the live-progress unsubscribe so we can tear it down on unmount too.
  const unsubProgress = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => unsubProgress.current?.();
  }, []);

  async function check() {
    setBusy(true);
    setNotice("");
    setResult(null);
    setPublished(null);
    setProgress(null);
    // Subscribe BEFORE the run so we don't miss the first "Question 1 of 5…".
    unsubProgress.current?.();
    unsubProgress.current = window.skovern.plugins.onProgress((p) => setProgress(p));
    const res = await window.skovern.plugins.run("ai-visibility", JSON.stringify({ name, category, city }));
    unsubProgress.current?.();
    unsubProgress.current = null;
    setProgress(null);
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

  async function publish() {
    if (!result) return;
    setPublishBusy(true);
    setPublished(null);
    const res = await window.skovern.visibility.publish({
      business: result.business,
      score: result.score,
      competitors: result.competitors,
    });
    setPublishBusy(false);
    setPublished({ url: res.url, message: res.message });
  }

  return (
    <section className="page page-narrow">
      <header className="page-head">
        <button className="page-back" onClick={onBack}>
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

        {busy && (
          <p className="hint">
            {progress
              ? `Question ${progress.step} of ${progress.total}… asking your brain, one at a time. Hang tight.`
              : "This can take a minute or two — I'm asking your brain a few questions, one at a time. Hang tight."}
          </p>
        )}
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
                <Answer>{f.answer}</Answer>
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

          <h2>Share it</h2>
          <p className="hint">Make a public link with a card — good for social or your website. Only what you see here is shared.</p>
          <div className="row">
            <button className="primary" onClick={() => void publish()} disabled={publishBusy}>
              {publishBusy ? "Making your link…" : "Publish a shareable link"}
            </button>
          </div>
          {published && (
            <div className="brain-reply">
              <p className="who">{published.url ? "Your link is ready" : "Hmm"}</p>
              {published.url ? (
                <p>
                  <a href={published.url} target="_blank" rel="noreferrer">
                    {published.url}
                  </a>
                </p>
              ) : (
                <p>{published.message}</p>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
