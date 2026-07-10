// Shapes crossing the renderer ↔ main IPC boundary for Skills. UI-facing: plain
// data and warm messages. `permissions` are the exact `explainCapability`
// sentences the user approves — no looser copy than what the broker enforces.

export interface SkillView {
  id: string;
  name: string;
  description: string;
  /** One plain-English line per declared capability (from `explainCapability`). */
  permissions: string[];
}

export interface RunSkillResult {
  ok: boolean;
  /** Warm, florist-facing status. */
  message: string;
  /** The skill's output, on success — untrusted, render escaped. */
  result?: string;
}

export interface SandboxCheckResult {
  /** The sandboxed child was denied reading a file outside its plugin dir. */
  fsReadDenied: boolean;
  /** The sandboxed child was denied spawning a subprocess. */
  spawnDenied: boolean;
  /** Diagnostic (perm model state + error codes) — for surfacing platform findings. */
  detail?: string;
}
