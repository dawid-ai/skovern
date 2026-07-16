// Shapes crossing renderer ↔ main for app settings + Ollama status. No secrets.

/** Whether Skovern may auto-start Ollama when it's installed but not running. */
export type OllamaLaunch = "ask" | "always" | "never";

export interface SettingsView {
  ollamaLaunch: OllamaLaunch;
}

export interface OllamaStatusView {
  installed: boolean;
  running: boolean;
  /** How many times we've attempted to auto-launch Ollama — present only under the dev/test
   *  fake-spawn seam, so an e2e can prove the consent→launch wiring fired. */
  launchAttempts?: number;
}
