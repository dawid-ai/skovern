import { useEffect, useState } from "react";
import type { BrainStatusView, ProviderId, Receipt } from "../../../shared/brain.js";
import { providerName } from "../../../shared/brain.js";
import type { OllamaLaunch, OllamaStatusView, SettingsView } from "../../../shared/settings.js";
import { LocalBrainSetup } from "./LocalBrainSetup.js";
import { UpdatesSection } from "../components/UpdatesSection.js";
import { Icon } from "../components/Icon.js";
import { OllamaSettings } from "./OllamaSettings.js";

// "Settings" — for now, the brain picker: choose where your assistant thinks,
// paste your key (kept safe on this computer), and test it with one real call.
// The test shows a receipt so you can see exactly what left your machine.

const BRAINS: { id: ProviderId; label: string; hint: string }[] = [
  { id: "local", label: "On this computer — free & private", hint: "Runs a brain right on your machine. Free, and nothing you type ever leaves." },
  { id: "claude-cli", label: "Claude Code (my subscription)", hint: "Use the Claude app you're already signed into — no key, no extra cost." },
  { id: "openrouter", label: "OpenRouter", hint: "One key, lots of brains to choose from." },
  { id: "anthropic", label: "Claude (Anthropic)", hint: "Your own Claude key." },
];

function brainLabel(id: ProviderId): string {
  return BRAINS.find((b) => b.id === id)?.label ?? id;
}

function fmtBytes(n: number): string {
  return n < 1024 ? `${n} bytes` : `${(n / 1024).toFixed(1)} KB`;
}

function receiptLine(r: Receipt): string {
  const time = new Date(r.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  // A local brain never "sends" — it runs on the machine. Be honest about it.
  if (r.local || r.provider === "local") {
    return `Ran on your computer at ${time} — nothing left your machine, and it answered.`;
  }
  return `Sent ${fmtBytes(r.bytesSent)} to ${brainLabel(r.provider)} at ${time} — and it answered.`;
}

export function SettingsPage({ onBrainChanged, onOpenYourBrain }: { onBrainChanged?: () => void; onOpenYourBrain?: () => void }) {
  const [provider, setProvider] = useState<ProviderId>("openrouter");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState<BrainStatusView>({
    configured: false,
    provider: null,
    model: null,
    builtinReady: false,
    ollamaInstalled: false,
    modelLoaded: false,
  });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const [settings, setSettings] = useState<SettingsView | null>(null);
  const [ollama, setOllama] = useState<OllamaStatusView | null>(null);

  // Refetch our own status AND tell the shell so the sidebar readout stays in step.
  const refreshStatus = () =>
    void window.skovern.brain.status().then((s) => {
      setStatus(s);
      onBrainChanged?.();
    });

  useEffect(() => {
    void window.skovern.brain.status().then((s) => {
      setStatus(s);
      if (s.provider) setProvider(s.provider);
    });
    void window.skovern.settings.get().then(setSettings);
    void window.skovern.settings.ollamaStatus().then(setOllama);
  }, []);

  async function changeOllamaLaunch(v: OllamaLaunch) {
    setSettings(await window.skovern.settings.setOllamaLaunch(v));
  }

  // "Use my built-in brain" (loop 033 Issue 3): record the choice, but if there's no built-in
  // model on disk yet, ROUTE to the setup/download flow instead of silently doing nothing —
  // the built-in floor isn't real until a model is downloaded.
  async function useBuiltin() {
    await changeOllamaLaunch("never");
    if (!status.builtinReady) setLocalOpen(true);
  }

  // The local brain has its own dedicated setup view (its own place, per the IA rule).
  if (localOpen) {
    return (
      <LocalBrainSetup
        onBack={() => {
          setLocalOpen(false);
          refreshStatus();
        }}
        onSaved={refreshStatus}
        onOpenYourBrain={onOpenYourBrain}
      />
    );
  }

  async function save() {
    setBusy(true);
    setNotice("");
    const res = await window.skovern.brain.save({ provider, key, model });
    setBusy(false);
    setNotice(res.message);
    if (res.ok) {
      setKey("");
      refreshStatus();
    }
  }

  async function test() {
    setBusy(true);
    setTesting(true);
    setNotice("");
    setReply(null);
    setReceipt(null);
    const res = await window.skovern.brain.test();
    setBusy(false);
    setTesting(false);
    setNotice(res.message);
    if (res.ok) {
      setReply(res.reply ?? "");
      setReceipt(res.receipt ?? null);
    }
  }

  return (
    <section className="page page-narrow settings-page">
      <header className="page-head">
        <h1>Settings</h1>
        <p>Pick the brain that powers your desk hand. Your key stays safe on this computer.</p>
      </header>

      <section className="group">
        <h2 className="g-head">Brain</h2>
        <div className="g-card">
          <p className={`g-row active-brain${status.provider === "local" ? " active-brain-local" : status.configured ? " active-brain-online" : ""}`}>
            {status.configured && status.provider ? (
              <>
                <span className="brain-dot" aria-hidden="true" /> Right now you’re using{" "}
                <strong>
                  {providerName(status.provider)}
                  {status.model ? ` — ${status.model}` : ""}
                </strong>
                .
              </>
            ) : (
              "You haven’t picked a brain yet — choose one below."
            )}
          </p>

          <div className="g-row g-field">
            <label htmlFor="brain">Pick a brain</label>
            <select id="brain" value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)}>
              {BRAINS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <div className="g-row g-sub">
            <p className="hint">{BRAINS.find((b) => b.id === provider)?.hint}</p>
          </div>

          {provider === "local" ? (
            <div className="g-row">
              <span className="tile tile-green">
                <Icon name="brain" />
              </span>
              <p className="hint g-main">
                {status.provider === "local"
                  ? "Your local brain is set up. Open it to change your model or check your computer again."
                  : "Set this up in its own place: we'll check your computer and help you pick a private brain."}
              </p>
              <button className="primary" onClick={() => setLocalOpen(true)}>
                Set up the local brain →
              </button>
            </div>
          ) : provider === "claude-cli" ? (
            <div className="g-row">
              <p className="hint">
                This brain runs on the Claude app on this computer, so there&apos;s nothing to paste. If it&apos;s not
                installed, we&apos;ll tell you when you test it.
              </p>
            </div>
          ) : (
            <div className="g-row g-field">
              <label htmlFor="key">Your key</label>
              <input
                id="key"
                type="password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={status.configured ? "A key is saved — paste a new one to replace it" : "Paste your key"}
              />
            </div>
          )}

          {/* The local brain picks its model in its own setup view, not here. */}
          {provider !== "local" && (
            <div className="g-row g-field">
              <label htmlFor="model">Which model? (optional)</label>
              <input
                id="model"
                type="text"
                value={model}
                onChange={(e) => setModel(e.target.value)}
                placeholder="Leave blank for a good default"
              />
            </div>
          )}

          <div className="g-row">
            <button className="link" onClick={() => void test()} disabled={busy || !status.configured}>
              {testing ? (
                <>
                  <span className="spinner" aria-hidden="true" /> Thinking…
                </>
              ) : (
                "Test my brain"
              )}
            </button>
            {provider !== "local" && (
              <span className="g-trail">
                <button
                  className="primary"
                  onClick={() => void save()}
                  disabled={busy || (provider !== "claude-cli" && key.trim().length === 0)}
                >
                  Save brain
                </button>
              </span>
            )}
          </div>
        </div>

        {notice.length > 0 && <p className="notice">{notice}</p>}

        {testing && (
          <div className="brain-reply brain-reply-busy">
            <p className="who">Your brain</p>
            <p className="processing">
              <span className="spinner" aria-hidden="true" /> Thinking it over…
            </p>
          </div>
        )}

        {reply !== null && (
          <div className="brain-reply">
            <p className="who">Your brain says</p>
            <p>{reply}</p>
          </div>
        )}
        {receipt !== null && <p className="receipt g-foot">{receiptLine(receipt)}</p>}
      </section>

      {ollama !== null && (
        <OllamaSettings
          ollama={ollama}
          settings={settings}
          onLaunch={(v) => void changeOllamaLaunch(v)}
          onUseBuiltin={() => void useBuiltin()}
        />
      )}

      <UpdatesSection />
    </section>
  );
}
