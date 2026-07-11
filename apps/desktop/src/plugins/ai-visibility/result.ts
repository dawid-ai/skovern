import type { Finding } from "./score.js";

// What the skill returns (JSON-serialized in `run`, parsed by the result view).
// The shape is ours/trusted; the string fields inside (answers, competitor names)
// are untrusted model output and MUST be rendered escaped by the UI.
export interface AiVisibilityResult {
  business: string;
  /** 0–100, computed by us from mention counts (never the model's self-rating). */
  score: number;
  /** The verbatim questions + answers — the "receipts" the user reads. */
  findings: Finding[];
  competitors: string[];
  fixits: string[];
}
