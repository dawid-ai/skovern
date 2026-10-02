import { YourModels } from "./YourModels.js";

// "Your brain" (loop 045, B3): its own nav page for what's on THIS computer — the brains you've
// downloaded, what's loaded in memory, Delete and Free memory. Moved out of the Settings depths so
// you can find it. Picking or changing a brain still happens in Settings / setup.
export function YourBrainPage({ onChanged, onSetup }: { onChanged: () => void; onSetup: () => void }) {
  return (
    <section className="page">
      <header className="page-head">
        <h1>Your brain</h1>
        <p>The private brains on this computer — how much room they take, and what&apos;s awake in memory right now.</p>
      </header>
      <YourModels refreshKey={0} onChanged={onChanged} onSetup={onSetup} />
    </section>
  );
}
