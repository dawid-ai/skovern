import { describe, expect, it } from "vitest";
import { verdict, type HardwareProfile } from "@skovern/core";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { allCandidates, builtInCandidates, guidedVerdict } from "./guided-verdict.js";

// Loop 037 — the flip-kill. The guided recommendation scores our BUILT-IN (gguf) catalog only,
// so it never lurches when a background Ollama starts/stops. We reproduce the exact composition
// that flipped: a 24 GB GPU, our built-in 3/7/14B (gguf), PLUS a bigger Ollama-only catalog
// entry (no gguf) — the kind that used to become the pick the moment Ollama came up.

const GB = 1024 * 1024 * 1024;

const CATALOG = [
  { id: "qwen2.5:3b", label: "Qwen2.5 3B", params: 3, gguf: { filename: "q3.gguf" } },
  { id: "qwen2.5:7b", label: "Qwen2.5 7B", params: 7, gguf: { filename: "q7.gguf" } },
  { id: "qwen2.5:14b", label: "Qwen2.5 14B", params: 14, gguf: { filename: "q14.gguf" } },
  // Ollama-only catalog entries (NO gguf block) — bigger, and green on a 24 GB card, so under
  // the OLD logic they'd outrank every built-in once Ollama was reachable.
  { id: "gemma2:22b", label: "Gemma2 22B (Ollama)", params: 22 },
  { id: "qwen2.5:32b", label: "Qwen2.5 32B (Ollama)", params: 32 },
];

function profile(p: Partial<HardwareProfile>): HardwareProfile {
  return { ramBytes: 64 * GB, cpuCores: 16, gpus: [], bestVramBytes: null, unifiedMemory: false, diskFreeBytes: 500 * GB, notes: [], ...p };
}

describe("guided verdict — built-in only (flip-kill, loop 037)", () => {
  it("U1: the candidate set excludes every non-built-in (Ollama-only) model — the flip can't happen", () => {
    const ids = builtInCandidates(CATALOG).map((m) => m.id);
    expect(ids).toEqual(["qwen2.5:3b", "qwen2.5:7b", "qwen2.5:14b"]);
    // the two bigger Ollama-only models — the ones that flipped the pick when Ollama woke — are
    // simply not candidates, whatever Ollama is doing. Ollama state is not even an input here.
    expect(ids).not.toContain("gemma2:22b");
    expect(ids).not.toContain("qwen2.5:32b");
  });

  // 047: still true of the BUILT-IN-ONLY verdict this test calls; the app's pick is now
  // `guidedVerdict` (below), which may name a bigger brain that runs through Ollama.
  it("U2: even though a bigger Ollama model scores green on 24 GB, the built-in-only verdict picks a built-in", () => {
    const gpu24 = profile({ bestVramBytes: 24 * GB });
    // Sanity: the 22B Ollama-only model really would be green+capable here (so the exclusion,
    // not a fit miss, is what keeps it out of the pick).
    const withOllama = verdict(gpu24, [...builtInCandidates(CATALOG), { id: "gemma2:22b", label: "Gemma2 22B", params: 22, fetchable: true }]);
    expect(withOllama.recommendedModelId).toBe("gemma2:22b"); // OLD world: the 22B wins

    const v = verdict(gpu24, builtInCandidates(CATALOG)); // NEW world: built-in only
    expect(v.recommendedModelId).toBe("qwen2.5:14b"); // biggest BUILT-IN green — never the 22B/32B
    const builtInIds = builtInCandidates(CATALOG).map((m) => m.id);
    expect(builtInIds).toContain(v.recommendedModelId); // negative: the pick is never a non-gguf id
  });

  it("U3: single source — the set is a pure function of the catalog, so headline and hero can't diverge", () => {
    // localStatus (headline) and localModels (hero) both call builtInCandidates(catalog.models);
    // an arg-only pure function means the two views always name the same model.
    expect(builtInCandidates(CATALOG)).toEqual(builtInCandidates(CATALOG));
    expect(builtInCandidates(CATALOG).every((m) => m.fetchable)).toBe(true); // built-ins always gettable
  });
});

describe("display tiers — Ollama rows get their REAL fit, not a default amber (BUG A, loop 042)", () => {
  it("U-new-1: allCandidates keeps the Ollama-only entries that builtInCandidates drops — so they CAN be scored", () => {
    const allIds = allCandidates(CATALOG).map((m) => m.id);
    expect(allIds).toEqual(["qwen2.5:3b", "qwen2.5:7b", "qwen2.5:14b", "gemma2:22b", "qwen2.5:32b"]);
    // the exact ids builtInCandidates threw away — the ones that used to default to amber.
    expect(allIds).toContain("gemma2:22b");
    expect(allIds).toContain("qwen2.5:32b");
  });

  it("U-new-2: on a 24 GB GPU a small Ollama model scores GREEN and a huge one amber/red — REAL per-model fit — while the pick stays a built-in", () => {
    const gpu24 = profile({ bestVramBytes: 24 * GB });
    // A small Ollama-only model alongside the huge ones: the display verdict must judge each on
    // its own merits, not blanket-amber every non-built-in.
    // 046: a genuinely huge one (70B ≈ 41 GB) joins, because with real KV math a Q4 32B (~20 GB)
    // DOES fit a 24 GB card (llmfit agrees) — the "huge model shows its honest non-green tier"
    // guard now rides the 70B.
    const cat = [
      ...CATALOG,
      { id: "llama3.2:1b", label: "Llama 3.2 1B (Ollama)", params: 1 },
      { id: "llama3.1:70b", label: "Llama 3.1 70B (Ollama)", params: 70 },
    ];
    const fitOf = (id: string) => verdict(gpu24, allCandidates(cat)).fits.find((f) => f.modelId === id)!.tier;

    expect(fitOf("llama3.2:1b")).toBe("green"); // a 1B on a 24 GB card is fast — the BUG A case
    expect(fitOf("gemma2:22b")).toBe("green"); // 22B still fits 24 GB → green
    expect(fitOf("qwen2.5:32b")).toBe("green"); // params 32, no size: ~20.1 GB of 24 GB (84%) → fits with room
    expect(fitOf("llama3.1:70b")).toBe("amber"); // ~43 GB: far bigger than the card, so it spills to RAM → honest amber (not defaulted)

    // The recommendation is UNCHANGED — the built-in-only pass still picks the biggest built-in,
    // never the (bigger, greener) Ollama models. Widening the DISPLAY set didn't widen the pick.
    expect(verdict(gpu24, builtInCandidates(cat)).recommendedModelId).toBe("qwen2.5:14b");
  });
});

describe("speed only for what we actually know (046)", () => {
  it("a model with no params and no size gets a tier but never a made-up speed", () => {
    const gpu24 = profile({ bestVramBytes: 24 * GB });
    const cat = [
      { id: "mystery:latest", label: "mystery:latest" }, // nothing known → 3B placeholder, guessed
      { id: "sized:latest", label: "sized:latest", sizeBytes: 2 * GB }, // size known → real estimate
    ];
    const fits = verdict(gpu24, allCandidates(cat)).fits;
    const mystery = fits.find((f) => f.modelId === "mystery:latest")!;
    expect(mystery.tier).toBe("green");
    expect(mystery.tokPerSec).toBeNull();
    expect(fits.find((f) => f.modelId === "sized:latest")!.tokPerSec).toBeGreaterThan(0);
  });
});

// 047: the app's ONE pick. A brain that runs through Ollama wins only when it's good AND bigger than
// the best good built-in; Ollama's state is never an input. Fixture = the SHIPPED catalog.
describe("guidedVerdict — Ollama brains join the pick (047)", () => {
  const shipped = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../catalog/models.json", import.meta.url)), "utf8")) as {
    models: Parameters<typeof guidedVerdict>[1];
  };
  const card = (vramGb: number, ramGb = 64) =>
    profile({ ramBytes: ramGb * GB, bestVramBytes: vramGb * GB, gpus: [{ model: "AMD Radeon RX 7900 XTX", vramBytes: vramGb * GB }] });

  it("G1: 24 GB card + Skovern can set Ollama up → the 32B (Dawid's box)", () => {
    const v = guidedVerdict(card(24), shipped.models, true);
    expect(v.recommendedModelId).toBe("qwen2.5:32b");
    expect(v.canRunGoodOne).toBe(true);
    expect(v.headline).toContain("Qwen2.5 32B");
  });

  it("G2: same card, but no helper build for this computer → the best built-in, as before", () => {
    expect(guidedVerdict(card(24), shipped.models, false).recommendedModelId).toBe("qwen2.5:14b");
  });

  it("G3: a small or slow computer is never asked to set up a helper", () => {
    for (const p of [profile({ ramBytes: 16 * GB }), profile({ ramBytes: 8 * GB }), card(8, 16), card(6, 16), card(3, 16), card(12, 32)]) {
      const pick = guidedVerdict(p, shipped.models, true).recommendedModelId;
      const entry = shipped.models.find((m) => m.id === pick);
      expect(entry?.gguf, JSON.stringify(p.bestVramBytes)).toBeDefined(); // a built-in
    }
  });

  it("G4: an equal-size Ollama brain never beats a built-in (llama3.2:3b vs qwen2.5:3b)", () => {
    const v = guidedVerdict(card(4, 16), shipped.models, true);
    expect(shipped.models.find((m) => m.id === v.recommendedModelId)?.gguf).toBeDefined();
  });

  // SEC-047-2: a catalog id that points the download at another server never becomes the pick.
  it("G5: a bigger catalog brain hosted off Ollama's registry is never the pick", () => {
    const withForeign = [...shipped.models, { id: "tracker.example/x/huge:40b", label: "Huge 40B", params: 40, sizeBytes: 21_000_000_000, quant: "Q4_K_M" }];
    const v = guidedVerdict(card(48), withForeign, true);
    expect(v.recommendedModelId).not.toBe("tracker.example/x/huge:40b");
    expect(v.recommendedModelId).toBe("qwen2.5:32b");
  });

  it("M11: pure — the same inputs always give the same pick (Ollama state isn't an input at all)", () => {
    expect(guidedVerdict.length).toBe(3);
    const a = guidedVerdict(card(24), shipped.models, true);
    const b = guidedVerdict(card(24), structuredClone(shipped.models), true);
    expect(b).toEqual(a);
  });
});
