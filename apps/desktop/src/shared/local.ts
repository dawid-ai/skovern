// Shapes crossing the renderer ↔ main IPC boundary for the Local Brain view.
// UI-facing plain data. The renderer NEVER touches Ollama or the network — main
// does every scan, fetch, and pull; the renderer only reads these views.

import type { FitTier, Verdict } from "@skovern/core";

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
  /** Already downloaded (in Ollama, or as a verified embedded file)? Drives "Get this
   *  one" vs "Use this one". */
  downloaded: boolean;
  /** Runs on the embedded runtime (has a gguf) → downloadable + usable WITHOUT Ollama.
   *  The UI keeps its action live even when Ollama is off. */
  embedded?: boolean;
  tier: FitTier;
  usable: boolean;
  /** Short label next to the tier dot, from the SAME fit as `tier`; amber says why (046). */
  fitLabel: string;
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
  /** Estimated tokens per second here (046) — from the SAME fit as `tier`. Null when it won't run
   *  here, memory is unknown, or we don't know the model's size at all. */
  tokPerSec: number | null;
}

/** Result of `local:status` — is Ollama here, and how does this computer look. */
export interface LocalStatusView {
  /** Is Ollama running + reachable on loopback right now? */
  ollamaReady: boolean;
  /** Is the Ollama helper INSTALLED (binary present), even if not running? Lets the setup
   *  screen offer a one-click "Start Ollama to see your models" instead of a dead end. */
  ollamaInstalled: boolean;
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
  /** Set when the recommended brain needs the helper (Ollama) and it isn't on this computer yet:
   *  the helper's size and the total with the brain, for the one consent (loop 047). */
  helper: { sizeBytes: number; size: string; totalSize: string } | null;
}

/** Result of a `local:pull` start / `local:save`. */
export interface LocalActionResult {
  ok: boolean;
  message: string;
}

/** Result of `local:connect` (loop 044) — probing a typed address BEFORE saving a brain. */
export interface ConnectProbeView {
  /** Did the address answer as a compatible brain server? */
  reachable: boolean;
  /** Is it OFF this computer (→ egress warning + receipts) vs on-box (→ light confirm)? */
  offBox: boolean;
  /** The normalized http origin we'd save (e.g. "http://192.168.1.5:11434"), or null if the
   *  address wasn't a valid http(s) host. */
  endpoint: string | null;
  /** The models the remote offers, to pick from. Empty when unreachable. */
  models: { id: string; label: string }[];
}

/** One downloaded model in the "Your models" manager. */
export interface DownloadedModelView {
  filename: string;
  id: string;
  label: string;
  /** Human size, e.g. "0.5 GB". */
  size: string;
  /** Is this the configured (active) brain? */
  active: boolean;
}

/** `local:downloadedModels` — the "Your models" view: what's on disk + what's in memory now. */
export interface YourModelsView {
  models: DownloadedModelView[];
  /** The model resident in VRAM right now (for the Memory row) — the warm embedded child, or a
   *  model Ollama has loaded — or null when nothing is loaded. */
  loadedLabel: string | null;
  /** The folder on disk where these downloaded brains live (userData/models), so the UI can show
   *  where they are and offer "Show in folder". */
  folder: string;
}

/** A pull-progress tick pushed main→renderer on the `local:pullProgress` channel. */
export interface PullProgressView {
  modelId: string;
  /** Which step of a helper set-up this is (loop 047); absent for a plain download. */
  phase?: SetupPhase;
  percent: number;
  /** Plain status ("downloading", "done", or an error line). */
  status: string;
  done: boolean;
  ok: boolean;
}

/** The steps of "set up the helper, then get the brain" (loop 047), in order. */
export type SetupPhase = "helper" | "unpack" | "start" | "brain";
