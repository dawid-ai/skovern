// Shapes crossing renderer ↔ main for app settings + Ollama status. No secrets.

/** Whether Deskhand may auto-start Ollama when it's installed but not running. */
export type OllamaLaunch = "ask" | "always" | "never";

export interface SettingsView {
  ollamaLaunch: OllamaLaunch;
}

export interface OllamaStatusView {
  installed: boolean;
  running: boolean;
}
