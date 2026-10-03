// Pure decision for switching brains (loop 045, B1): what must be freed from memory when the
// active brain changes, so the old model doesn't stay resident in VRAM next to the new one. Kept
// out of the Electron-coupled `local.ts` so every direction is unit-testable.

/** The fields of a brain config the switch decision reads. */
export interface SwitchBrain {
  provider: string;
  model?: string;
  endpoint?: string;
  /** Stored with an embedded brain at save time (045) — marks it built-in without the catalog. */
  filename?: string;
}

export interface SwitchPlan {
  /** Unload the embedded (built-in) runtime's resident model. */
  unloadEmbedded: boolean;
  /** Loopback Ollama model ids to unload (keep_alive:0). */
  unloadOllama: string[];
}

const NOTHING: SwitchPlan = { unloadEmbedded: false, unloadOllama: [] };

/** Given the outgoing brain (null on a first-ever save), the incoming one, how to tell an embedded
 *  model from an Ollama one, and which model (if any) the embedded runtime holds warm right now,
 *  decide what to free. Only a LOCAL outgoing brain holds our memory; a brain connected by address runs on someone
 *  else's box, so we never reach off-box to unload it. Re-saving the same brain frees nothing (no
 *  warm-brain thrash). A warm built-in behind an Ollama brain is the self-reliant fallback answering
 *  for an unreachable Ollama (033) — it's the outgoing brain's memory too, so it's freed, unless
 *  it IS the brain you're switching to (no pointless reload). */
export function brainSwitchPlan(
  prev: SwitchBrain | null,
  next: SwitchBrain,
  ctx: { isEmbedded: (modelId: string) => boolean; warmEmbedded: string | null },
): SwitchPlan {
  if (!prev || prev.provider !== "local" || !prev.model) return NOTHING;
  if (prev.endpoint) return NOTHING; // connected by address: not our memory, and not our box
  const same = next.provider === "local" && next.model === prev.model && (next.endpoint ?? "") === "";
  if (same) return NOTHING;
  return prev.filename !== undefined || ctx.isEmbedded(prev.model)
    ? { unloadEmbedded: true, unloadOllama: [] }
    : { unloadEmbedded: ctx.warmEmbedded !== null && ctx.warmEmbedded !== next.model, unloadOllama: [prev.model] };
}
