import { afterEach, describe, expect, it, vi } from "vitest";

// Loop 034 — the two new dev/test seams must be IGNORED in a packaged build (U9): a shipped
// user's environment can neither fake a "loaded/green" chip (SKOVERN_BRAIN_LOADED) nor
// disable/shrink the idle-unload (SKOVERN_IDLE_UNLOAD_MS). Mirror of the existing
// SKOVERN_NOW / SKOVERN_HARDWARE / SKOVERN_OLLAMA_URL gating.

// vi.mock is hoisted above imports; vi.hoisted lets the mutable `app` be shared with the tests.
const app = vi.hoisted(() => ({ isPackaged: false, getPath: () => "." }));
vi.mock("electron", () => ({ app }));

import { idleUnloadMs, modelLoaded } from "./local.js";

afterEach(() => {
  app.isPackaged = false;
  delete process.env["SKOVERN_BRAIN_LOADED"];
  delete process.env["SKOVERN_IDLE_UNLOAD_MS"];
});

describe("SKOVERN_IDLE_UNLOAD_MS", () => {
  it("honored when unpackaged", () => {
    process.env["SKOVERN_IDLE_UNLOAD_MS"] = "250";
    expect(idleUnloadMs()).toBe(250);
  });

  it("U9: IGNORED when packaged (→ undefined, engine keeps its 5-min default)", () => {
    process.env["SKOVERN_IDLE_UNLOAD_MS"] = "250";
    app.isPackaged = true;
    expect(idleUnloadMs()).toBeUndefined();
  });

  it("a garbage value falls back to the default (undefined)", () => {
    process.env["SKOVERN_IDLE_UNLOAD_MS"] = "soon-ish";
    expect(idleUnloadMs()).toBeUndefined();
  });
});

describe("SKOVERN_BRAIN_LOADED", () => {
  it("honored when unpackaged — forces the chip state without probing", async () => {
    process.env["SKOVERN_BRAIN_LOADED"] = "1";
    // qwen2.5:3b is embedded; with the seam forcing "1" it never even reads the warm child.
    expect(await modelLoaded("qwen2.5:3b")).toBe(true);
    process.env["SKOVERN_BRAIN_LOADED"] = "0";
    expect(await modelLoaded("qwen2.5:3b")).toBe(false);
  });

  it("U9: IGNORED when packaged — falls through to the real probe (cold embedded → false)", async () => {
    process.env["SKOVERN_BRAIN_LOADED"] = "1";
    app.isPackaged = true;
    expect(await modelLoaded("qwen2.5:3b")).toBe(false);
  });
});
