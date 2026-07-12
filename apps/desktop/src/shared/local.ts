// Shapes crossing the renderer ↔ main IPC boundary for the Local Brain view.
// UI-facing plain data. The renderer NEVER touches Ollama or the network — main
// does every scan, fetch, and pull; the renderer only reads these views.

import type { FitTier, Verdict } from "@deskhand/core";

export type { FitTier, Verdict };

/** A machine snapshot in plain, already-formatted words for the UI. */
export interface HardwareView {
  /** e.g. "16 GB memory" — pre-formatted so the renderer does no math. */
  ram: string;
  cpu: string;
  /** Best graphics device we'd use, already described ("AMD Radeon (24 GB)"). */
  gpu: string;
  disk: string;
  /** Honest degradation notes to show under the verdict. */
  notes: string[];
}

/** One model row the view renders. `group` decides which list it lands in. */
export interface LocalModelView {
  id: string;
  label: string;
  /** "what you already have" (pulled in Ollama) vs "our suggestions" (catalog). */
  group: "have" | "suggested";
  /** Already downloaded (in Ollama)? Drives "Get this one" vs "Ready to use". */
  downloaded: boolean;
  tier: FitTier;
  usable: boolean;
  /** Warm one-liner for this model on this computer. */
  note: string;
  /** True for the single best pick — highlighted in the UI. */
  recommended: boolean;
  /** Catalog-only transparency (absent for a user's own pulled models). */
  creator?: string;
  homepage?: string;
  license?: string;
  licenseUrl?: string;
  tradeoff?: string;
  /** Human size ("2.0 GB"), when known. */
  size?: string;
}

/** Result of `local:status` — is Ollama here, and how does this computer look. */
export interface LocalStatusView {
  /** Is Ollama running + reachable on loopback right now? */
  ollamaReady: boolean;
  hardware: HardwareView;
  verdict: Verdict;
  /** A friendly line when Ollama isn't running (else empty). */
  notice: string;
}

/** Result of `local:models` — both groups, fit-checked, plus any catalog notice. */
export interface LocalModelsView {
  ollamaReady: boolean;
  models: LocalModelView[];
  /** e.g. the offline-snapshot notice, or Ollama-not-running message. */
  notice: string;
}

/** Result of a `local:pull` start / `local:save`. */
export interface LocalActionResult {
  ok: boolean;
  message: string;
}

/** A pull-progress tick pushed main→renderer on the `local:pullProgress` channel. */
export interface PullProgressView {
  modelId: string;
  percent: number;
  /** Plain status ("downloading", "done", or an error line). */
  status: string;
  done: boolean;
  ok: boolean;
}
