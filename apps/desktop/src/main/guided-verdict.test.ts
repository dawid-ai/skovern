import { describe, expect, it } from "vitest";
import { verdict, type HardwareProfile } from "@skovern/core";
import { allCandidates, builtInCandidates } from "./guided-verdict.js";

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

  it("U2: even though a bigger Ollama model scores green on 24 GB, the pick is ALWAYS a built-in", () => {
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
    expect(fitOf("qwen2.5:32b")).not.toBe("red"); // ~20 GB of 24 GB: it fits (green, or amber if only just)
    expect(fitOf("llama3.1:70b")).toBe("amber"); // ~43 GB: far bigger than the card, so it spills to RAM → honest amber (not defaulted)

    // The recommendation is UNCHANGED — the built-in-only pass still picks the biggest built-in,
    // never the (bigger, greener) Ollama models. Widening the DISPLAY set didn't widen the pick.
    expect(verdict(gpu24, builtInCandidates(cat)).recommendedModelId).toBe("qwen2.5:14b");
  });
});
