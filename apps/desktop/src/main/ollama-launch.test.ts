import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// app.isPackaged=false so the dev/test seams are honoured; getPath for knownOllamaPaths.
vi.mock("electron", () => ({ app: { isPackaged: false, getPath: () => "/home/test" } }));

import { ensureOllamaRunning, fakeLaunchCount, ollamaInstalled, pickOllamaAction } from "./ollama-launch.js";

const savedEnv = { ...process.env };
beforeEach(() => {
  delete process.env["SKOVERN_OLLAMA_INSTALLED"];
  delete process.env["SKOVERN_OLLAMA_SPAWN_FAKE"];
});
afterEach(() => {
  process.env = { ...savedEnv };
  vi.restoreAllMocks();
});

describe("pickOllamaAction", () => {
  it("uses Ollama when it's already running (regardless of preference)", () => {
    expect(pickOllamaAction(true, true, "never")).toBe("use-ollama");
    expect(pickOllamaAction(false, true, "ask")).toBe("use-ollama");
  });
  it("launches only when installed AND opted-in (always)", () => {
    expect(pickOllamaAction(true, false, "always")).toBe("launch-then-use");
    expect(pickOllamaAction(false, false, "always")).toBe("use-builtin"); // not installed → can't
  });
  it("uses the built-in for ask/never when Ollama is down", () => {
    expect(pickOllamaAction(true, false, "ask")).toBe("use-builtin");
    expect(pickOllamaAction(true, false, "never")).toBe("use-builtin");
  });
});

describe("ollamaInstalled seam", () => {
  it("honours the unpackaged test seam", () => {
    process.env["SKOVERN_OLLAMA_INSTALLED"] = "1";
    expect(ollamaInstalled()).toBe(true);
    process.env["SKOVERN_OLLAMA_INSTALLED"] = "0";
    expect(ollamaInstalled()).toBe(false);
  });
});

describe("ensureOllamaRunning (fake spawn)", () => {
  it("attempts a launch but reports not-running (the fake doesn't serve) → caller falls back", async () => {
    process.env["SKOVERN_OLLAMA_SPAWN_FAKE"] = "1";
    const before = fakeLaunchCount();
    const detect = vi.fn(async () => false);
    const ok = await ensureOllamaRunning(detect, 1000);
    expect(ok).toBe(false); // fake never serves
    expect(fakeLaunchCount()).toBe(before + 1); // but the launch WAS attempted
    expect(detect).not.toHaveBeenCalled(); // short-circuits the poll for the fake
  });
});
