import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = { dir: "" };
vi.mock("electron", () => ({ app: { getPath: () => state.dir } }));

import { getSettings, setAutoUpdates, setOllamaLaunch } from "./settings-store.js";

beforeEach(() => {
  state.dir = mkdtempSync(path.join(tmpdir(), "skovern-settings-"));
});
afterEach(() => {
  rmSync(state.dir, { recursive: true, force: true });
});

describe("settings-store", () => {
  it("defaults ollamaLaunch to 'ask' when nothing is written", () => {
    expect(getSettings().ollamaLaunch).toBe("ask");
  });

  it("round-trips the ollamaLaunch preference", () => {
    setOllamaLaunch("always");
    expect(getSettings().ollamaLaunch).toBe("always");
    setOllamaLaunch("never");
    expect(getSettings().ollamaLaunch).toBe("never");
  });

  it("ignores a bad value and a corrupt file, falling back to the default", () => {
    // @ts-expect-error — a hostile/buggy value must not persist
    setOllamaLaunch("garbage");
    expect(getSettings().ollamaLaunch).toBe("ask");
    writeFileSync(path.join(state.dir, "settings.json"), "{ not json");
    expect(getSettings().ollamaLaunch).toBe("ask");
  });

  it("checks for updates automatically unless turned off, and keeps the other setting", () => {
    expect(getSettings().autoUpdates).toBe(true);
    setOllamaLaunch("always");
    setAutoUpdates(false);
    expect(getSettings()).toEqual({ ollamaLaunch: "always", autoUpdates: false });
    writeFileSync(path.join(state.dir, "settings.json"), JSON.stringify({ autoUpdates: "no" }));
    expect(getSettings().autoUpdates).toBe(true);
  });
});
