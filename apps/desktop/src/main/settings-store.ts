import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { OllamaLaunch } from "../shared/settings.js";

// Small main-owned app settings (NOT secrets — those stay in the keychain). Plain JSON in
// userData: whether Skovern may auto-start Ollama, and whether it checks for updates by itself.

export type { OllamaLaunch };

export interface Settings {
  ollamaLaunch: OllamaLaunch;
  /** "Check for updates automatically" — on unless the user turns it off. */
  autoUpdates: boolean;
}

const DEFAULTS: Settings = { ollamaLaunch: "ask", autoUpdates: true };

function settingsFile(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

function isLaunch(v: unknown): v is OllamaLaunch {
  return v === "ask" || v === "always" || v === "never";
}

/** Current settings, defaults for anything missing/corrupt (never throws). */
export function getSettings(): Settings {
  try {
    const raw: unknown = JSON.parse(readFileSync(settingsFile(), "utf8"));
    const o = (raw ?? {}) as Record<string, unknown>;
    return {
      ollamaLaunch: isLaunch(o["ollamaLaunch"]) ? o["ollamaLaunch"] : DEFAULTS.ollamaLaunch,
      autoUpdates: typeof o["autoUpdates"] === "boolean" ? o["autoUpdates"] : DEFAULTS.autoUpdates,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Persist the Ollama auto-launch preference (best-effort). */
export function setOllamaLaunch(value: OllamaLaunch): void {
  const next: Settings = { ...getSettings(), ollamaLaunch: isLaunch(value) ? value : "ask" };
  writeFileSync(settingsFile(), JSON.stringify(next));
}

/** Persist "Check for updates automatically" (best-effort). */
export function setAutoUpdates(on: boolean): void {
  const next: Settings = { ...getSettings(), autoUpdates: on === true };
  writeFileSync(settingsFile(), JSON.stringify(next));
}
