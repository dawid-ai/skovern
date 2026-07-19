import { useState } from "react";
import type { ConnectProbeView } from "../../../shared/local.js";

// "Connect your own brain by address" (loop 044) — the power-user advanced lane. Type an
// address:port (Ollama, LM Studio, a llama.cpp server, a box on your network); Skovern talks to it
// but never installs or manages it. Ceremony matches whether bytes leave the machine:
//   - on your computer (localhost) → a light "stays here" confirm.
//   - another computer → a clear "this leaves your computer" warning + consent BEFORE we connect,
//     and every call is logged in Receipts.
// Talks ONLY to window.skovern.* — no network/OS access here.
export function ConnectBrain({ onConnected }: { onConnected: () => void }) {
  const [address, setAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  // The off-box consent gate: once the user has been warned about an off-box address, they tick
  // this before we send the first byte.
  const [offBoxHost, setOffBoxHost] = useState<string | null>(null); // set → showing the warning
  const [probe, setProbe] = useState<ConnectProbeView | null>(null); // set → showing the model list

  function reset(): void {
    setOffBoxHost(null);
    setProbe(null);
    setNote("");
  }

  // Step 1: classify the typed address WITHOUT touching the network. If it's off-box, show the
  // warning + consent first; if it's on your computer, go straight to probing.
  async function onConnectClick(): Promise<void> {
    reset();
    setBusy(true);
    const { valid, offBox, endpoint } = await window.skovern.local.classify(address);
    setBusy(false);
    if (!valid || !endpoint) {
      setNote("That address doesn't look right — try like 192.168.1.5:11434.");
      return;
    }
    if (offBox) {
      setOffBoxHost(new URL(endpoint).host); // gate: warn + consent before any byte leaves
      return;
    }
    await doProbe(); // localhost — stays on your computer, no warning
  }

  // Step 2: probe (reachable? which models?). For an off-box address this is the first call that
  // leaves the machine — reached only AFTER the consent above.
  async function doProbe(): Promise<void> {
    setBusy(true);
    setNote("");
    const result = await window.skovern.local.connect(address);
    setBusy(false);
    if (!result.reachable) {
      setNote("Couldn't reach a brain at that address. Check it's running and the address is right.");
      setProbe(null);
      return;
    }
    setProbe(result);
  }

  // Step 3: pick a model → save it as the active brain (endpoint re-validated in main).
  async function use(modelId: string): Promise<void> {
    if (!probe?.endpoint) return;
    setBusy(true);
    const res = await window.skovern.brain.save({ provider: "local", key: "", model: modelId, endpoint: probe.endpoint });
    setBusy(false);
    if (!res.ok) {
      setNote(res.message);
      return;
    }
    setNote(`Connected — ${modelId} is now your brain.`);
    onConnected();
  }

  return (
    <div className="local-group connect-brain">
      <h2>Connect your own brain</h2>
      <p className="hint">
        Already run a brain somewhere — on this computer or another one on your network? Type its
        address and Skovern will use it. We don&apos;t install or manage it — that&apos;s yours.
      </p>

      <div className="connect-row">
        <input
          type="text"
          aria-label="Brain address"
          placeholder="192.168.1.5:11434"
          value={address}
          onChange={(e) => {
            setAddress(e.target.value);
            reset();
          }}
          disabled={busy}
        />
        <button className="primary" onClick={() => void onConnectClick()} disabled={busy || address.trim().length === 0}>
          {busy ? "Checking…" : "Connect"}
        </button>
      </div>

      {/* Off-box: a clear warning + explicit consent BEFORE we send anything. */}
      {offBoxHost && !probe && (
        <div className="connect-warning">
          <p>
            <strong>{offBoxHost}</strong> is on another computer. Your messages will{" "}
            <strong>leave this computer</strong> to reach it, and every one is written to your
            Receipts log. Only connect to a brain you trust.
          </p>
          <div className="row">
            <button className="primary" onClick={() => void doProbe()} disabled={busy}>
              {busy ? "Connecting…" : "I understand — connect anyway"}
            </button>
            <button className="link" onClick={reset} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* On-box: a light reassurance. */}
      {probe && !probe.offBox && (
        <p className="hint connect-onbox">This brain runs on your computer — nothing leaves it.</p>
      )}

      {/* The models the remote offers → pick one. */}
      {probe && probe.models.length > 0 && (
        <ul className="connect-models">
          {probe.models.map((m) => (
            <li key={m.id} className="connect-model-row">
              <span>{m.label}</span>
              <button className="primary" onClick={() => void use(m.id)} disabled={busy}>
                Use this one
              </button>
            </li>
          ))}
        </ul>
      )}
      {probe && probe.models.length === 0 && (
        <p className="hint">Connected, but that brain has no models to run yet.</p>
      )}

      {note.length > 0 && <p className="notice">{note}</p>}
    </div>
  );
}
