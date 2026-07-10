import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Electron: a controllable safeStorage + a temp userData dir. encryptString
// just tags the text so we can prove decrypt round-trips and that a "plaintext"
// write never happens when encryption is unavailable.
const state = { available: true, dir: "" };

vi.mock("electron", () => ({
  app: { getPath: () => state.dir },
  safeStorage: {
    isEncryptionAvailable: () => state.available,
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
}));

import { clearSession, loadSession, saveSession } from "./session.js";

beforeEach(() => {
  state.dir = mkdtempSync(path.join(tmpdir(), "deskhand-session-"));
  state.available = true;
});

afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true });
});

describe("session storage", () => {
  it("round-trips an encrypted session", () => {
    saveSession({ token: "id.secret", ogNumber: 5 });
    expect(loadSession()).toEqual({ token: "id.secret", ogNumber: 5 });
  });

  it("refuses to persist when the OS keychain is unavailable — no plaintext on disk", () => {
    state.available = false;
    expect(() => saveSession({ token: "id.secret", ogNumber: 5 })).toThrow(/secure storage unavailable/);
    expect(existsSync(path.join(state.dir, "session.bin"))).toBe(false);
  });

  it("returns null when there's no session, and clears one that exists", () => {
    expect(loadSession()).toBeNull();
    saveSession({ token: "id.secret", ogNumber: 5 });
    expect(loadSession()).not.toBeNull();
    clearSession();
    expect(loadSession()).toBeNull();
  });
});
