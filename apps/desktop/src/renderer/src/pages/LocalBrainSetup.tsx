import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalModelView, LocalStatusView, PullProgressView } from "../../../shared/local.js";

// "On this computer — free & private": the local-brain setup view, reached from
// Settings (its own place, per the IA rule). It shows an honest hardware verdict,
// the models you already have and our suggestions (with trade-offs + fit), lets
// you download a suggestion via Ollama with a progress bar, and pick one to run.
// The renderer makes NO network calls — every scan/fetch/pull happens in main.

const TIER_WORD: Record<string, string> = {
  green: "Runs great here",
  amber: "Runs, but slowly",
  red: "Too big for this computer",
};

// Defense in depth: main already dropped non-http links, but never render one that
// isn't plainly http(s) as a clickable href.
function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  return /^https?:\/\//i.test(url) ? url : undefined;
}

export function LocalBrainSetup({ onBack, onSaved }: { onBack: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState<LocalStatusView | null>(null);
  const [models, setModels] = useState<LocalModelView[] | null>(null);
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [pulling, setPulling] = useState<Record<string, PullProgressView>>({});
  const unsubPull = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    setBusy(true);
    const [s, m] = await Promise.all([window.deskhand.local.status(), window.deskhand.local.models()]);
    setStatus(s);
    setModels(m.models);
    setNotice(m.notice || s.notice || "");
    setBusy(false);
  }, []);

  useEffect(() => {
    void refresh();
    return () => unsubPull.current?.();
  }, [refresh]);

  async function useModel(id: string) {
    const res = await window.deskhand.brain.save({ provider: "local", key: "", model: id });
    setNotice(res.message);
    if (res.ok) {
      setSavedId(id);
      onSaved();
    }
  }

  async function getModel(id: string) {
    setPulling((prev) => ({ ...prev, [id]: { modelId: id, percent: 0, status: "starting", done: false, ok: true } }));
    // Subscribe BEFORE the pull so we don't miss early ticks (016 pattern).
    unsubPull.current?.();
    unsubPull.current = window.deskhand.local.onPullProgress((p) => {
      setPulling((prev) => ({ ...prev, [p.modelId]: p }));
    });
    const res = await window.deskhand.local.pull(id);
    unsubPull.current?.();
    unsubPull.current = null;
    if (res.ok) {
      setPulling((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      await refresh(); // it's downloaded now → the row flips to "Use this"
    } else {
      setNotice(res.message);
    }
  }

  // One obvious pick up front (the verdict's single recommendation, spanning both
  // groups); EVERYTHING else — your other models + the other suggestions — folds
  // under "Other options" so a zero-knowledge user just clicks the one thing.
  const all = models ?? [];
  const recommended = all.find((m) => m.recommended) ?? null;
  const others = all.filter((m) => !m.recommended);
  const otherHave = others.filter((m) => m.group === "have");
  const otherSuggested = others.filter((m) => m.group === "suggested");

  function modelCard(m: LocalModelView) {
    const prog = pulling[m.id];
    const href = safeHref(m.homepage);
    const licenseHref = safeHref(m.licenseUrl);
    return (
      <li key={m.id} className={m.recommended ? "card local-model best" : "card local-model"}>
        <div className="local-model-head">
          <span className={`fit-dot fit-${m.tier}`} aria-hidden="true" />
          <h3>{m.label}</h3>
          {m.recommended && <span className="best-badge">Best for your computer</span>}
          {m.downloaded && <span className="have-badge">Already on your computer</span>}
        </div>
        <p className="hint">
          {TIER_WORD[m.tier] ?? ""}
          {m.size ? ` · ${m.size}` : ""}
          {m.note ? ` — ${m.note}` : ""}
        </p>
        {m.tradeoff && <p className="hint">{m.tradeoff}</p>}
        {m.creator && (
          <p className="hint local-transparency">
            Made by {m.creator}, not by Deskhand — a free file you run privately.
            {m.license ? ` ${m.license}` : ""}{" "}
            {href && (
              <a href={href} target="_blank" rel="noreferrer">
                Where it comes from →
              </a>
            )}
            {licenseHref && (
              <>
                {" · "}
                <a href={licenseHref} target="_blank" rel="noreferrer">
                  license
                </a>
              </>
            )}
          </p>
        )}

        {prog && !prog.done ? (
          <div className="pull-progress">
            <div className="pull-bar">
              <div className="pull-fill" style={{ width: `${Math.max(3, prog.percent)}%` }} />
            </div>
            <p className="hint">Downloading… {prog.percent}%</p>
          </div>
        ) : (
          <div className="row">
            {m.downloaded ? (
              <button className="primary" onClick={() => void useModel(m.id)} disabled={savedId === m.id}>
                {savedId === m.id ? "This is your brain ✓" : "Use this one"}
              </button>
            ) : (
              <button className="primary" onClick={() => void getModel(m.id)} disabled={!status?.ollamaReady}>
                Get this one
              </button>
            )}
          </div>
        )}
      </li>
    );
  }

  return (
    <section className="page">
      <header className="page-head">
        <button className="link" onClick={onBack}>
          ← Back to Settings
        </button>
        <h1>On this computer</h1>
        <p>A private brain that runs right here — free, and nothing you type ever leaves your machine.</p>
      </header>

      {status === null ? (
        <p className="hint">Checking your computer…</p>
      ) : (
        <>
          <div className="card local-verdict">
            <p className="local-headline">{status.verdict.headline}</p>
            <ul className="hint local-specs">
              <li>{status.hardware.gpu}</li>
              <li>{status.hardware.ram}</li>
              <li>{status.hardware.cpu}</li>
              <li>{status.hardware.disk}</li>
            </ul>
            {status.hardware.notes.map((n, i) => (
              <p key={i} className="hint">
                {n}
              </p>
            ))}
            <div className="row">
              <button className="link" onClick={() => void refresh()} disabled={busy}>
                {busy ? "Checking…" : "Check my computer again"}
              </button>
            </div>
          </div>

          {notice.length > 0 && <p className="notice">{notice}</p>}

          {!status.ollamaReady ? (
            // Ollama not running → no actionable pick exists; lead with the honest
            // guidance (the verdict still scores the catalog, but there's nothing to
            // click yet), and fold any models under "Other options".
            <p className="hint">
              Start Ollama (the free helper that runs a private brain), then choose “Check my computer again.”
            </p>
          ) : recommended ? (
            <>
              <h2>Our pick for your computer</h2>
              <p className="hint">One click and you’re set — nothing to figure out.</p>
              <ul className="news-list">{modelCard(recommended)}</ul>
            </>
          ) : (
            <p className="hint">
              No private brain runs well on this computer — your free cloud brain or your subscription will
              serve you better.
            </p>
          )}

          {others.length > 0 && (
            <details className="other-options">
              <summary>Other options</summary>
              {otherHave.length > 0 && (
                <>
                  <h3>Models you already have</h3>
                  <ul className="news-list">{otherHave.map(modelCard)}</ul>
                </>
              )}
              {otherSuggested.length > 0 && (
                <>
                  <h3>Other suggestions</h3>
                  <ul className="news-list">{otherSuggested.map(modelCard)}</ul>
                </>
              )}
            </details>
          )}
        </>
      )}
    </section>
  );
}
