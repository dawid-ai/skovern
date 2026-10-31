import type { BrainStatusView } from "../../../shared/brain.js";
import { providerShort } from "../../../shared/brain.js";

// The always-visible brain chip at the foot of the sidebar. Two lines, like design A: which brain,
// then its state in a word. Green only when a private brain is awake; gray when it's asleep or
// there is none; amber when the brain is online (what you type leaves this computer).
export function BrainChip({ brain }: { brain: BrainStatusView }) {
  const local = brain.provider === "local";
  const kind = local ? (brain.modelLoaded ? "local" : "asleep") : brain.configured ? "online" : "none";
  const state = kind === "local" ? "Awake" : kind === "asleep" ? "Asleep" : kind === "online" ? "Online" : null;
  const title = local
    ? brain.modelLoaded
      ? "Your private brain is awake — nothing leaves this computer"
      : "Your private brain is asleep — it wakes up when you chat"
    : "Your active brain";

  return (
    <div className={`brain-chip brain-chip-${kind}`} title={title}>
      <span className="brain-dot" aria-hidden="true" />
      <span className="brain-chip-lines">
        {brain.configured && brain.provider ? (
          <span className="brain-chip-text">
            {providerShort(brain.provider)}
            {brain.model ? `: ${brain.model}` : ""}
          </span>
        ) : (
          <span className="brain-chip-text brain-chip-empty">No brain yet</span>
        )}
        {state && <span className="brain-chip-state">{state}</span>}
      </span>
    </div>
  );
}
