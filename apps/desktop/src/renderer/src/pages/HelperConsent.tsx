import type { PullProgressView, SetupPhase } from "../../../shared/local.js";

// Loop 047: the one consent before Skovern sets up its helper (Ollama) for a bigger brain. The
// helper is named once, here — we're putting a program on their computer, so we say so — and
// nowhere else on the guided screen.
export function HelperConsent({
  totalSize,
  helperSize,
  onYes,
  onNo,
}: {
  totalSize: string;
  helperSize: string;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <div className="helper-consent" role="dialog" aria-label="Set up the helper">
      <p>
        This brain needs a free helper program called Ollama. Skovern sets it up for you and only runs it while Skovern
        is open.
      </p>
      <p className="hint">
        About {totalSize} to download in all (the helper is {helperSize}). Big downloads take a while — you can keep
        using Skovern.
      </p>
      <div className="row">
        <button className="primary" onClick={onYes}>
          Set it up
        </button>
        <button className="link" onClick={onNo}>
          Not now
        </button>
      </div>
    </div>
  );
}

const PHASE_WORDS: Record<SetupPhase, string> = {
  helper: "Getting the helper",
  unpack: "Setting up the helper",
  start: "Starting the helper",
  brain: "Getting the brain",
};

/** The progress line under the bar: which step, and how far, in plain words. */
export function progressWords(p: PullProgressView): string {
  if (!p.phase) return `Downloading… ${p.percent}%`;
  const words = PHASE_WORDS[p.phase];
  return p.phase === "helper" || p.phase === "brain" ? `${words}… ${p.percent}%` : `${words}…`;
}
