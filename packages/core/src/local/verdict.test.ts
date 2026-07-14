import { describe, expect, it } from "vitest";
import { verdict } from "./verdict.js";
import type { HardwareProfile, VerdictModel } from "./types.js";

// V1 — the honesty table. verdict() is pure, so we assert per-model fit + usability
// + the warm overall verdict across representative machines, INCLUDING the honest
// "your machine can't run a good one → use the cloud" case.

const GB = 1024 * 1024 * 1024;

const MODELS: VerdictModel[] = [
  { id: "qwen2.5:0.5b", label: "Qwen 0.5B", params: 0.5 },
  { id: "qwen2.5:3b", label: "Qwen 3B", params: 3 },
  { id: "qwen2.5:7b", label: "Qwen 7B", params: 7 },
  { id: "qwen2.5:14b", label: "Qwen 14B", params: 14 },
];

function profile(p: Partial<HardwareProfile>): HardwareProfile {
  return {
    ramBytes: null,
    cpuCores: 8,
    gpus: [],
    bestVramBytes: null,
    unifiedMemory: false,
    diskFreeBytes: 500 * GB,
    notes: [],
    ...p,
  };
}

function tierOf(v: ReturnType<typeof verdict>, id: string): string {
  return v.fits.find((f) => f.modelId === id)!.tier;
}

describe("verdict — honesty table", () => {
  it("workstation (24GB VRAM): everything is fast, recommends the biggest capable model", () => {
    const v = verdict(profile({ ramBytes: 64 * GB, bestVramBytes: 24 * GB }), MODELS);
    expect(tierOf(v, "qwen2.5:0.5b")).toBe("green");
    expect(tierOf(v, "qwen2.5:3b")).toBe("green");
    expect(tierOf(v, "qwen2.5:7b")).toBe("green");
    expect(tierOf(v, "qwen2.5:14b")).toBe("green");
    expect(v.canRunGoodOne).toBe(true);
    expect(v.recommendedModelId).toBe("qwen2.5:14b");
    expect(v.headline).toMatch(/private brain/i);
  });

  it("laptop (8GB discrete VRAM): mid models fast, the 14B spills to RAM (amber)", () => {
    const v = verdict(profile({ ramBytes: 16 * GB, bestVramBytes: 8 * GB }), MODELS);
    expect(tierOf(v, "qwen2.5:3b")).toBe("green");
    expect(tierOf(v, "qwen2.5:7b")).toBe("green");
    expect(tierOf(v, "qwen2.5:14b")).toBe("amber");
    expect(v.canRunGoodOne).toBe(true);
    expect(v.recommendedModelId).toBe("qwen2.5:7b");
  });

  it("apple unified (16GB shared): a capable model is fast, the 14B won't fit", () => {
    const v = verdict(profile({ ramBytes: 16 * GB, unifiedMemory: true }), MODELS);
    expect(tierOf(v, "qwen2.5:7b")).toBe("green");
    expect(tierOf(v, "qwen2.5:14b")).toBe("red");
    expect(v.canRunGoodOne).toBe(true);
    expect(v.recommendedModelId).toBe("qwen2.5:7b");
  });

  it("potato (8GB, no usable GPU): CPU-only — small ones work but slowly, big one won't", () => {
    const v = verdict(profile({ ramBytes: 8 * GB }), MODELS);
    // nothing is green on CPU — the honesty rule: CPU never = fast
    expect(v.fits.every((f) => f.tier !== "green")).toBe(true);
    expect(tierOf(v, "qwen2.5:3b")).toBe("amber");
    expect(tierOf(v, "qwen2.5:14b")).toBe("red");
    expect(v.canRunGoodOne).toBe(false);
    // it still offers a local pick, honestly framed
    expect(v.recommendedModelId).not.toBeNull();
    expect(v.headline).toMatch(/slow|cloud|subscription/i);
  });

  it("the honest can't-run case (4GB, no GPU): steers to the cloud brain", () => {
    const v = verdict(profile({ ramBytes: 4 * GB }), MODELS);
    expect(tierOf(v, "qwen2.5:7b")).toBe("red");
    expect(tierOf(v, "qwen2.5:14b")).toBe("red");
    expect(v.canRunGoodOne).toBe(false);
    expect(v.headline).toMatch(/cloud brain|subscription/i);
  });

  it("a weak iGPU (below the useful-VRAM floor) is treated as CPU-only, not a false promise", () => {
    // 1.5GB iGPU < the 2GB floor → no green, honest CPU verdict
    const v = verdict(profile({ ramBytes: 16 * GB, bestVramBytes: Math.round(1.5 * GB) }), MODELS);
    expect(v.fits.every((f) => f.tier !== "green")).toBe(true);
    expect(v.canRunGoodOne).toBe(false);
  });

  it("unknown memory: honestly says it's unsure rather than guessing a pass", () => {
    const v = verdict(profile({ ramBytes: null }), MODELS);
    expect(v.fits.every((f) => f.tier === "amber")).toBe(true);
    expect(v.fits[0]!.note).toMatch(/couldn't check|not sure/i);
  });
});

// V2 — the recommendation must be a model the user can ACTUALLY get. A model marked
// `fetchable:false` (e.g. an Ollama-only model when Ollama isn't installed) is still
// scored in the fit table, but is NEVER recommended — recommending a model whose
// download button is dead is the bug this pins (24GB machine, no Ollama, only the
// small embedded model is gettable).
describe("verdict — recommends only a fetchable model", () => {
  it("skips the biggest capable model when it isn't fetchable, picks the best fetchable one", () => {
    const models: VerdictModel[] = [
      { id: "qwen2.5:3b", label: "Qwen 3B", params: 3, fetchable: true }, // embedded, gettable
      { id: "qwen2.5:7b", label: "Qwen 7B", params: 7, fetchable: false }, // Ollama-only, no Ollama
      { id: "qwen2.5:14b", label: "Qwen 14B", params: 14, fetchable: false },
    ];
    const v = verdict(profile({ ramBytes: 64 * GB, bestVramBytes: 24 * GB }), models);
    expect(tierOf(v, "qwen2.5:14b")).toBe("green"); // still scored in the fit table
    expect(v.recommendedModelId).toBe("qwen2.5:3b"); // but the pick is the fetchable one
    expect(v.headline).toContain("Qwen 3B"); // headline names the SAME model (no divergence)
  });

  it("recommends nothing (not a dead button) when no fetchable model is usable", () => {
    const models: VerdictModel[] = [{ id: "qwen2.5:7b", label: "Qwen 7B", params: 7, fetchable: false }];
    const v = verdict(profile({ ramBytes: 64 * GB, bestVramBytes: 24 * GB }), models);
    expect(v.recommendedModelId).toBeNull();
  });

  it("fetchable defaults to true — existing callers/behaviour unchanged", () => {
    const v = verdict(profile({ ramBytes: 64 * GB, bestVramBytes: 24 * GB }), MODELS);
    expect(v.recommendedModelId).toBe("qwen2.5:14b");
  });

  // Loop 028 prod scenario: 3B/7B/14B all shipped as embedded (fetchable) GGUFs; on a big
  // GPU the pick is the biggest FITTING embedded one (14B) — the flagship path. On a small
  // machine it steps down to the biggest embedded that still fits, never over-promising.
  it("all three embedded on a 24GB GPU → recommends the 14B; on a small machine it steps down", () => {
    const embedded: VerdictModel[] = [
      { id: "qwen2.5:3b", label: "Qwen 3B", params: 3, fetchable: true },
      { id: "qwen2.5:7b", label: "Qwen 7B", params: 7, fetchable: true },
      { id: "qwen2.5:14b", label: "Qwen 14B", params: 14, fetchable: true },
    ];
    expect(verdict(profile({ ramBytes: 64 * GB, bestVramBytes: 24 * GB }), embedded).recommendedModelId).toBe("qwen2.5:14b");
    // 8GB VRAM: the 14B spills (amber), so the biggest GREEN embedded (7B) is the pick.
    expect(verdict(profile({ ramBytes: 16 * GB, bestVramBytes: 8 * GB }), embedded).recommendedModelId).toBe("qwen2.5:7b");
  });
});
