import { app, safeStorage } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProviderId } from "@deskhand/core";

// The user's brain choice + its API key. The key is a secret: it lives ONLY here,
// encrypted by the OS keychain (safeStorage), and is NEVER returned to the
// renderer — only `brainStatus()` (no key) crosses back.

export interface BrainConfig {
  provider: ProviderId;
  key: string;
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
    if (
      (parsed.provider !== "openrouter" && parsed.provider !== "anthropic") ||
      typeof parsed.key !== "string"
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Renderer-safe: whether a brain is set and which one — never the key. */
export function brainStatus(): { configured: boolean; provider: ProviderId | null } {
  const brain = loadBrain();
  return { configured: brain !== null, provider: brain?.provider ?? null };
}

export function clearBrain(): void {
  const file = brainFile();
  if (existsSync(file)) rmSync(file);
}
