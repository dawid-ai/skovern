import { useState } from "react";
import { LocalBrainSetup } from "./LocalBrainSetup.js";

// First-run onboarding: a florist with nothing installed needs a working brain WITHOUT
// knowing what Ollama is. The self-reliant default is the built-in, on-computer brain, so
// we lead there and reuse the existing embedded-first setup (hardware scan → recommended
// model → download → active). "Use an online brain" drops them into the app (Settings) so
// they're never trapped on this screen.
export function Onboarding({ onConfigured, onSkip }: { onConfigured: () => void; onSkip: () => void }) {
  const [showLocal, setShowLocal] = useState(false);

  if (showLocal) {
    // onSaved fires when a brain becomes active → the shell's gate re-checks and lets them in.
    // Wrap in a scroll container: on first-run this screen isn't inside the shell's `.content`,
    // so without this the tall setup page clips at the bottom (Issue 1).
    return (
      <div className="content">
        <LocalBrainSetup guided onBack={() => setShowLocal(false)} onSaved={onConfigured} />
      </div>
    );
  }

  return (
    <main className="home">
      <div className="card onboarding-card">
        <div className="mark" aria-hidden="true">
          S
        </div>
        <h1>Let&apos;s set up your brain.</h1>
        <p>
          Skovern needs a brain to think with. The easiest is a private one that runs right
          here on your computer — it&apos;s free, and nothing you type ever leaves. No accounts, no
          keys, nothing to install yourself.
        </p>
        <div className="form">
          <button className="primary" onClick={() => setShowLocal(true)}>
            Set up my private brain →
          </button>
          <button className="link" onClick={onSkip}>
            I&apos;d rather use an online brain
          </button>
        </div>
      </div>
    </main>
  );
}
