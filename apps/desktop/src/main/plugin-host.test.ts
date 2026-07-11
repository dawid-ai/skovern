import { describe, expect, it, vi } from "vitest";

// plugin-host.ts imports electron at module load (used only inside functions we don't
// call here). Stub it so importing the pure `validateProgress` resolves in plain Node.
vi.mock("electron", () => ({ app: { getPath: () => "" } }));

import { validateProgress } from "./plugin-host.js";

// The host trust boundary for the child→host progress notification (loop 016). The
// child is the eventual home of untrusted plugins, so a spoofed, flooded, or malformed
// progress message must never reach the renderer or crash main. `validateProgress` is
// the pure gate: it returns a clean {step,total} ONLY for the active run with sane
// integers, else null (drop). These tests exercise it directly — no real fork needed.

const ACTIVE = 7; // the host-owned active runId under test

describe("validateProgress (host trust boundary)", () => {
  // P1 — runId gating: an id that isn't the active run's is dropped, so a child's
  // echoed id can't drive progress for another/absent run (same posture as `result`).
  it("P1: drops a progress message whose runId ≠ the active run", () => {
    expect(validateProgress({ runId: ACTIVE + 1, step: 2, total: 5 }, ACTIVE)).toBeNull();
    expect(validateProgress({ runId: 0, step: 2, total: 5 }, ACTIVE)).toBeNull();
    // positive control: the SAME shape with the active id is forwarded
    expect(validateProgress({ runId: ACTIVE, step: 2, total: 5 }, ACTIVE)).toEqual({ step: 2, total: 5 });
  });

  // P2 — payload validation: every bad shape returns null (no throw into main). Each
  // case is asserted individually so a regression names the exact shape that slipped.
  describe("P2: drops bad step/total shapes without throwing", () => {
    const bad: Array<[string, unknown, unknown]> = [
      ["non-integer step (float)", 1.5, 5],
      ["non-integer total (float)", 2, 5.5],
      ["negative step", -1, 5],
      ["negative total", 2, -5],
      ["zero step (below 1)", 0, 5],
      ["zero total (below 1)", 1, 0],
      ["NaN step", NaN, 5],
      ["NaN total", 2, NaN],
      ["Infinity step", Infinity, 5],
      ["Infinity total", 2, Infinity],
      ["step > total", 6, 5],
      ["total above the sane cap (1001)", 1, 1001],
      ["string step", "2", 5],
      ["string total", 2, "5"],
      ["missing step", undefined, 5],
      ["missing total", 2, undefined],
    ];
    for (const [name, step, total] of bad) {
      it(`drops: ${name}`, () => {
        // A pure function that returns null never threw — that's the "no throw" proof.
        expect(validateProgress({ runId: ACTIVE, step, total }, ACTIVE)).toBeNull();
      });
    }

    it("forwards a well-formed {step:2,total:5} (positive control)", () => {
      expect(validateProgress({ runId: ACTIVE, step: 2, total: 5 }, ACTIVE)).toEqual({ step: 2, total: 5 });
    });

    it("accepts the boundaries: step===1, step===total, total===1000", () => {
      expect(validateProgress({ runId: ACTIVE, step: 1, total: 1000 }, ACTIVE)).toEqual({ step: 1, total: 1000 });
      expect(validateProgress({ runId: ACTIVE, step: 5, total: 5 }, ACTIVE)).toEqual({ step: 5, total: 5 });
    });

    it("does not throw on a non-object / null message — returns null", () => {
      expect(validateProgress(null, ACTIVE)).toBeNull();
      expect(validateProgress(undefined, ACTIVE)).toBeNull();
      expect(validateProgress("progress", ACTIVE)).toBeNull();
      expect(validateProgress(42, ACTIVE)).toBeNull();
    });
  });

  // P3 — one-way, integers only: the forwarded payload is EXACTLY {step,total}, so no
  // brain output, capability result, or answer text can ride the progress channel even
  // if the child stuffs extra fields into the message.
  it("P3: the forwarded payload has exactly the keys step and total — nothing rides along", () => {
    const clean = validateProgress(
      { runId: ACTIVE, step: 3, total: 5, output: "SECRET BRAIN TEXT", answer: "leak", type: "progress" },
      ACTIVE,
    );
    expect(clean).not.toBeNull();
    expect(Object.keys(clean!).sort()).toEqual(["step", "total"]);
    expect(clean).toEqual({ step: 3, total: 5 });
  });
});
