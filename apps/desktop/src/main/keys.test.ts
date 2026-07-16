import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock Electron: a temp userData dir, and a trivial-but-reversible safeStorage so
// save/load round-trips without a real OS keychain.
const state = { dir: "" };
vi.mock("electron", () => ({
  app: { getPath: () => state.dir },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8"),
  },
}));

import { brainStatus, clearBrain, saveBrain } from "./keys.js";

beforeEach(() => {
  state.dir = mkdtempSync(path.join(tmpdir(), "skovern-keys-"));
});
afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true });
});

describe("brainStatus", () => {
  it("returns configured/provider/model and NEVER the key (local)", () => {
    saveBrain({ provider: "local", key: "", model: "qwen2.5:3b" });
    const s = brainStatus();
    expect(s).toEqual({ configured: true, provider: "local", model: "qwen2.5:3b" });
    expect(s).not.toHaveProperty("key");
  });

  it("surfaces an API-provider's model but never leaks its secret key", () => {
    saveBrain({ provider: "anthropic", key: "sk-super-secret-123", model: "claude-sonnet-5" });
    const s = brainStatus();
    expect(s.provider).toBe("anthropic");
    expect(s.model).toBe("claude-sonnet-5");
    expect(s).not.toHaveProperty("key");
    // Belt-and-suspenders: the secret appears nowhere in the serialized status.
    expect(JSON.stringify(s)).not.toContain("sk-super-secret-123");
  });

  it("reports no brain when none is saved", () => {
    clearBrain();
    expect(brainStatus()).toEqual({ configured: false, provider: null, model: null });
  });
});
