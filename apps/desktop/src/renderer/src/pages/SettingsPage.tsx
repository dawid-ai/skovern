import { useEffect, useState } from "react";
import type { ProviderId, Receipt } from "../../../shared/brain.js";

// "Settings" — for now, the brain picker: choose where your assistant thinks,
// paste your key (kept safe on this computer), and test it with one real call.
// The test shows a receipt so you can see exactly what left your machine.

const BRAINS: { id: ProviderId; label: string; hint: string }[] = [
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
  return `Sent ${fmtBytes(r.bytesSent)} to ${brainLabel(r.provider)} at ${time} — and it answered.`;
}

export function SettingsPage() {
  const [provider, setProvider] = useState<ProviderId>("openrouter");
  const [key, setKey] = useState("");
  const [model, setModel] = useState("");
  const [status, setStatus] = useState<{ configured: boolean; provider: ProviderId | null }>({
    configured: false,
    provider: null,
  });
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  useEffect(() => {
    void window.deskhand.brain.status().then((s) => {
      setStatus(s);
      if (s.provider) setProvider(s.provider);
    });
  }, []);

  async function save() {
    setBusy(true);
    setNotice("");
    const res = await window.deskhand.brain.save({ provider, key, model });
    setBusy(false);
    setNotice(res.message);
    if (res.ok) {
      setKey("");
      setStatus(await window.deskhand.brain.status());
    }
  }

  async function test() {
    setBusy(true);
    setNotice("");
    setReply(null);
    setReceipt(null);
    const res = await window.deskhand.brain.test();
    setBusy(false);
    setNotice(res.message);
    if (res.ok) {
      setReply(res.reply ?? "");
      setReceipt(res.receipt ?? null);
    }
  }

  return (
    <section className="page">
      <header className="page-head">
        <h1>Settings</h1>
        <p>Pick the brain that powers your desk hand. Your key stays safe on this computer.</p>
      </header>

      <div className="form">
        <label htmlFor="brain">Your brain</label>
        <select
          id="brain"
          value={provider}
          onChange={(e) => setProvider(e.target.value as ProviderId)}
        >
          {BRAINS.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
        <p className="hint">{BRAINS.find((b) => b.id === provider)?.hint}</p>

        {provider === "claude-cli" ? (
          <p className="hint">
            This brain runs on the Claude app on this computer, so there&apos;s nothing to paste. If it&apos;s not
            installed, we&apos;ll tell you when you test it.
          </p>
        ) : (
          <>
            <label htmlFor="key">Your key</label>
            <input
              id="key"
              type="password"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder={status.configured ? "A key is saved — paste a new one to replace it" : "Paste your key"}
            />
          </>
        )}

        <label htmlFor="model">Which model? (optional)</label>
        <input
          id="model"
          type="text"
          value={model}
          onChange={(e) => setModel(e.target.value)}
          placeholder="Leave blank for a good default"
        />

        <div className="row">
          <button
            className="primary"
            onClick={() => void save()}
            disabled={busy || (provider !== "claude-cli" && key.trim().length === 0)}
          >
            Save brain
          </button>
          <button className="link" onClick={() => void test()} disabled={busy || !status.configured}>
            Test my brain
          </button>
        </div>

        {notice.length > 0 && <p className="notice">{notice}</p>}

        {reply !== null && (
          <div className="brain-reply">
            <p className="who">Your brain says</p>
            <p>{reply}</p>
          </div>
        )}
        {receipt !== null && <p className="receipt">{receiptLine(receipt)}</p>}
      </div>
    </section>
  );
}
