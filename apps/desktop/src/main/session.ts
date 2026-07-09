import { app, safeStorage } from "electron";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface StoredSession {
  token: string;
  ogNumber: number;
}

function sessionFile(): string {
  return path.join(app.getPath("userData"), "session.bin");
}

export function saveSession(session: StoredSession): void {
  if (!safeStorage.isEncryptionAvailable()) {
    // Security invariant: a bearer token never touches disk in plaintext. If the
    // OS keychain isn't available we simply don't persist (user stays signed in
    // for this run only).
    throw new Error("OS secure storage unavailable — refusing to persist session");
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(session));
  writeFileSync(sessionFile(), encrypted);
}

export function loadSession(): StoredSession | null {
  const file = sessionFile();
  if (!existsSync(file) || !safeStorage.isEncryptionAvailable()) return null;
  try {
    const parsed = JSON.parse(safeStorage.decryptString(readFileSync(file))) as StoredSession;
    if (typeof parsed.token !== "string" || typeof parsed.ogNumber !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearSession(): void {
  const file = sessionFile();
  if (existsSync(file)) rmSync(file);
}
