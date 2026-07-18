import { describe, expect, it } from "vitest";
import { verdict, type HardwareProfile } from "@skovern/core";
import { builtInCandidates } from "./guided-verdict.js";

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
