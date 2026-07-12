import { app, safeStorage } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProviderId } from "@deskhand/core";

// The user's brain choice + its API key. The key is a secret: it lives ONLY here,
// encrypted by the OS keychain (safeStorage), and is NEVER returned to the
// renderer — only `brainStatus()` (no key) crosses back. The `claude-cli` brain
// (the Claude Code subscription) has NO key — it rides the logged-in CLI.

const PROVIDERS: readonly ProviderId[] = ["openrouter", "anthropic", "claude-cli", "local"];

export interface BrainConfig {
  provider: ProviderId;
  /** Empty for `claude-cli` and `local` (no key); the API-key providers require it. */
  key: string;
  /** For `local`, this is the chosen Ollama model id (e.g. "qwen2.5:3b"). */
  model?: string;
}

function brainFile(): string {
  return path.join(app.getPath("userData"), "brain.bin");
}

export function saveBrain(config: BrainConfig): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // Security invariant: an API key never touches disk in plaintext.
    throw new Error("OS secure storage unavailable — refusing to store the key");
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(config));
  writeFileSync(brainFile(), encrypted);
}

export function loadBrain(): BrainConfig | null {
  const file = brainFile();
  if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file))) as BrainConfig;
    // Validate the trust boundary uniformly: known provider, string key, and (if
    // present) a string model — a non-string model is rejected, not trusted.
    if (
      !PROVIDERS.includes(parsed.provider) ||
      typeof parsed.key !== "string" ||
      (parsed.model !== undefined && typeof parsed.model !== "string")
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Renderer-safe: whether a brain is set, which one, and its model — never the key.
 *  The model id is a public name (e.g. "qwen2.5:3b"), safe to show; the API key
 *  stays in this process only. */
export function brainStatus(): { configured: boolean; provider: ProviderId | null; model: string | null } {
  const brain = loadBrain();
  return { configured: brain !== null, provider: brain?.provider ?? null, model: brain?.model ?? null };
}

export function clearBrain(): void {
  const file = brainFile();
  if (existsSync(file)) rmSync(file);
}
