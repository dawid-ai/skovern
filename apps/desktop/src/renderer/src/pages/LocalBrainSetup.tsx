import { useCallback, useEffect, useRef, useState } from "react";
import type { LocalModelView, LocalStatusView, PullProgressView } from "../../../shared/local.js";
import { partitionModels } from "./local-partition.js";

// "On this computer — free & private": the local-brain setup view, reached from
// Settings (its own place, per the IA rule). Full-width: two callout cards up top —
// "This is your brain" (the model you're using) and "Our pick" (what we recommend),
// so it's obvious what's active vs suggested even when they differ — then one clean
// table of EVERY model (fit, size, status, action), nothing hidden behind a fold.
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
    const [s, m, b] = await Promise.all([
      window.deskhand.local.status(),
      window.deskhand.local.models(),
      window.deskhand.brain.status(),
    ]);
    setStatus(s);
    setModels(m.models);
    setNotice(m.notice || s.notice || "");
    // Mark the model you're actually using ("This is your brain"), even before you
    // click anything this session.
    setSavedId(b.provider === "local" ? b.model : null);
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
      // Download AND use in one click: you asked for this model, so make it your brain.
      await useModel(id);
      await refresh();
    } else {
      setNotice(res.message);
    }
  }

  const all = models ?? [];
  // Embedded-first: what's actionable now (embedded, or Ollama models when Ollama is up)
  // vs what needs Ollama that isn't running (demoted to a collapsed "Advanced" section).
  const { here, advanced } = partitionModels(all, status?.ollamaReady ?? false);
  const active = savedId ? all.find((m) => m.id === savedId) ?? null : null;
  const recommended = all.find((m) => m.recommended) ?? null;
  // Embedded models run WITHOUT Ollama, so the actionable UI shows whenever Ollama is
  // ready OR at least one embedded model exists (the no-Ollama private-brain path).
  const hasEmbedded = all.some((m) => m.embedded);
  const canAct = (status?.ollamaReady ?? false) || hasEmbedded;
  // One card when the model you're using IS the recommendation — no confusing dupes.
  const sameActiveAndPick = active !== null && recommended !== null && active.id === recommended.id;

  // The action for a model, shared by the callout cards and the table rows: a live
  // download bar, "This is your brain ✓" (disabled) for the active one, "Use this one"
  // for a downloaded model, or "Get this one" (needs Ollama) for one to fetch.
  function action(m: LocalModelView) {
    const prog = pulling[m.id];
    if (prog && !prog.done) {
      return (
        <div className="pull-progress">
          <div className="pull-bar">
            <div className="pull-fill" style={{ width: `${Math.max(3, prog.percent)}%` }} />
          </div>
          <p className="hint">Downloading… {prog.percent}%</p>
        </div>
      );
    }
    // The model you're already using: never offer to re-download or re-pick it.
    if (savedId === m.id) {
      return (
        <button className="primary" disabled>
          This is your brain ✓
        </button>
      );
    }
    if (m.downloaded) {
      return (
        <button className="primary" onClick={() => void useModel(m.id)}>
          Use this one
        </button>
      );
    }
    // An embedded model downloads via our own downloader — no Ollama needed, so its
    // button stays live. A non-embedded (Ollama) model needs Ollama running to fetch —
    // when it's not, say so honestly instead of showing a dead, unexplained button.
    const needsOllama = !m.embedded && !status?.ollamaReady;
    return (
      <button className="primary" onClick={() => void getModel(m.id)} disabled={needsOllama}>
        {needsOllama ? "Needs Ollama" : "Get this one"}
      </button>
    );
  }

  // The honest provenance line — every model is someone else's free file you run privately.
  function transparency(m: LocalModelView, compact: boolean) {
    if (!m.creator) return null;
    const href = safeHref(m.homepage);
    const licenseHref = safeHref(m.licenseUrl);
    return (
      <p className="hint local-transparency">
        {compact ? `by ${m.creator}` : `Made by ${m.creator}, not by Deskhand — a free file you run privately.`}
        {m.license ? ` ${m.license}` : ""}{" "}
        {href && (
          <a href={href} target="_blank" rel="noreferrer">
            source →
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
    );
  }

  function callout(m: LocalModelView, kind: "brain" | "pick" | "both") {
    const label = kind === "brain" ? "This is your brain" : kind === "pick" ? "Our pick for your computer" : "Your brain — our pick, too";
    return (
      <div className={`callout callout-${kind === "both" ? "brain" : kind}`}>
        <span className="callout-label">{label}</span>
        <div className="callout-model">
          <span className={`fit-dot fit-${m.tier}`} aria-hidden="true" />
          <h3>{m.label}</h3>
        </div>
        <p className="hint">
          {TIER_WORD[m.tier] ?? ""}
          {m.size ? ` · ${m.size}` : ""}
          {m.note ? ` — ${m.note}` : m.tradeoff ? ` — ${m.tradeoff}` : ""}
        </p>
        {transparency(m, false)}
        <div className="callout-action">{action(m)}</div>
      </div>
    );
  }

  // The status word for a model in the table.
  function statusOf(m: LocalModelView): { text: string; cls: string } {
    if (savedId === m.id) return { text: "Your brain ✓", cls: "status-active" };
    if (m.recommended) return { text: "Our pick", cls: "status-pick" };
    if (m.downloaded) return { text: "On your computer", cls: "status-have" };
    return { text: "Not downloaded", cls: "status-none" };
  }

  // One model table — shared by the main "runs here" list and the Advanced (Ollama) list.
  function modelTable(rows: LocalModelView[]) {
    return (
      <div className="receipt-scroll">
        <table className="receipt-table local-table">
          <thead>
            <tr>
              <th>Model</th>
              <th>Fits your computer</th>
              <th>Size</th>
              <th>Status</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => {
              const st = statusOf(m);
              return (
                <tr key={m.id} className="receipt-row">
                  <td className="receipt-what">
                    <span className="receipt-who">{m.label}</span>
                    {transparency(m, true)}
                  </td>
                  <td>
                    <span className="local-fit">
                      <span className={`fit-dot fit-${m.tier}`} aria-hidden="true" />
                      {TIER_WORD[m.tier] ?? ""}
                    </span>
                  </td>
                  <td>{m.size ?? "—"}</td>
                  <td>
                    <span className={`local-status ${st.cls}`}>{st.text}</span>
                  </td>
                  <td className="local-action-cell">{action(m)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <section className="page">
      <header className="page-head">
        <button className="page-back" onClick={onBack}>
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

          {!canAct ? (
            // Nothing actionable: no Ollama AND no embedded model. Lead with the honest
            // guidance (the verdict still scores the catalog, but there's nothing to click).
            <p className="hint">
              Start Ollama (the free helper that runs a private brain), then choose “Check my computer again.”
            </p>
          ) : (
            <>
              {/* Callouts: what you're using + what we recommend, obvious even when different. */}
              {(active || recommended) && (
                <div className="local-callouts">
                  {sameActiveAndPick && active
                    ? callout(active, "both")
                    : (
                      <>
                        {active && callout(active, "brain")}
                        {recommended && callout(recommended, "pick")}
                      </>
                    )}
                </div>
              )}

              {!recommended && !active && (
                <p className="hint">
                  No private brain runs well on this computer — your free cloud brain or your subscription will
                  serve you better. You can still pick any model below.
                </p>
              )}

              {/* Embedded-first: models that download AND run right here (no Ollama) up
                  top; anything that needs the Ollama helper tucked into "Advanced". */}
              {here.length > 0 && (
                <div className="local-group">
                  <h2>Runs on this computer</h2>
                  <p className="hint">
                    Pick one and Deskhand downloads it and runs it right here. Nothing you type ever leaves.
                  </p>
                  {modelTable(here)}
                </div>
              )}

              {advanced.length > 0 && (
                <details className="local-advanced">
                  <summary>Advanced — models that need Ollama ({advanced.length})</summary>
                  <p className="hint">
                    These run through Ollama, a separate free helper. If it&apos;s not installed and running, they
                    can&apos;t download here — the ones above need nothing extra.
                  </p>
                  {modelTable(advanced)}
                </details>
              )}
            </>
          )}
        </>
      )}
    </section>
  );
}
