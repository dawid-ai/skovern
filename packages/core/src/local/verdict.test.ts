import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { fitFor, verdict } from "./verdict.js";
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

  // 046 behavior change (N7, llmfit's rule): running partly on the processor needs the whole model
  // to fit in system RAM on its own. The 14B (~9.8 GB) is too big for the 8 GB card AND for 8 GB
  // of RAM, so it's red — the old pooled VRAM+RAM budget called it amber.
  it("laptop (8GB card, 8GB RAM): the 14B can't spill to RAM that's too small → red", () => {
    const v = verdict(profile({ ramBytes: 8 * GB, bestVramBytes: 8 * GB }), MODELS);
    expect(tierOf(v, "qwen2.5:7b")).toBe("green");
    expect(tierOf(v, "qwen2.5:14b")).toBe("red");
    expect(v.fits.find((f) => f.modelId === "qwen2.5:14b")!.tokPerSec).toBeNull();
  });

  // 046 (approved behavior change): the old red came from the 1.2× headroom and a flat
  // 0.15 GB/B KV overestimate. With real KV math the 14B needs ~9.8 GB of the ~10.6 GB a 16 GB Mac
  // can spare — it JUST fits, so it's amber "only just fits", never green. The intent holds: we
  // don't promise a 14B is fast on a 16 GB Mac, and the pick is still the 7B.
  it("apple unified (16GB shared): a capable model is fast, the 14B only just fits (amber)", () => {
    const v = verdict(profile({ ramBytes: 16 * GB, unifiedMemory: true }), MODELS);
    expect(tierOf(v, "qwen2.5:7b")).toBe("green");
    expect(tierOf(v, "qwen2.5:14b")).toBe("amber");
    expect(v.fits.find((f) => f.modelId === "qwen2.5:14b")!.note).toMatch(/only just fits/i);
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

// 046 — the math lives in @dawid-ai/model-fit; this file only maps it to tiers + words.
describe("verdict — delegates the math (046)", () => {
  it("S1: the module is pinned to an EXACT version, installed from the npm registry with an integrity hash", () => {
    const root = new URL("../../../../", import.meta.url);
    for (const pkg of ["packages/core/package.json", "apps/desktop/package.json"]) {
      const deps = JSON.parse(readFileSync(fileURLToPath(new URL(pkg, root)), "utf8")) as Record<string, Record<string, string> | undefined>;
      const v = deps["dependencies"]?.["@dawid-ai/model-fit"] ?? deps["devDependencies"]?.["@dawid-ai/model-fit"];
      expect(v, pkg).toMatch(/^\d+\.\d+\.\d+$/); // no ^, ~, link:, file:, or git URL
    }
    const lock = readFileSync(fileURLToPath(new URL("pnpm-lock.yaml", root)), "utf8");
    expect(lock).toMatch(/'@dawid-ai\/model-fit@\d+\.\d+\.\d+':\n\s+resolution: \{integrity: sha512-/);
  });

  it("S1: no weight/KV/headroom arithmetic remains in verdict.ts", () => {
    const src = readFileSync(fileURLToPath(new URL("./verdict.ts", import.meta.url)), "utf8");
    for (const sym of ["HEADROOM", "kvBytes", "weightBytes", "footprint", "budgetOf"]) expect(src, sym).not.toContain(sym);
    expect(src).toContain('from "@dawid-ai/model-fit"');
  });

  it("speed is shown for a model that runs, never for red or when memory is unknown", () => {
    const gpu = verdict(profile({ ramBytes: 64 * GB, bestVramBytes: 24 * GB, gpus: [{ model: "AMD Radeon RX 7900 XTX", vramBytes: 24 * GB }] }), MODELS);
    const s3 = gpu.fits.find((f) => f.modelId === "qwen2.5:3b")!.tokPerSec;
    expect(s3).toBeGreaterThan(100); // 960 GB/s ÷ (3B × 0.5 B/param) × 0.55 ≈ 350
    const cpu = verdict(profile({ ramBytes: 16 * GB }), MODELS);
    expect(cpu.fits.find((f) => f.modelId === "qwen2.5:3b")!.tokPerSec).toBeGreaterThan(0); // amber: runs, slowly
    expect(cpu.fits.find((f) => f.modelId === "qwen2.5:14b")!.tier).toBe("red");
    expect(cpu.fits.find((f) => f.modelId === "qwen2.5:14b")!.tokPerSec).toBeNull(); // red → no speed
    const unknown = verdict(profile({}), MODELS);
    expect(unknown.fits.every((f) => f.tokPerSec === null)).toBe(true);
  });

  it("S2: every SHIPPED catalog id resolves its architecture; an alias resolves; hostile ids only miss", () => {
    const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../catalog/models.json", import.meta.url)), "utf8")) as {
      models: { id: string; label: string; params: number; sizeBytes: number; quant: string }[];
    };
    const p = profile({ ramBytes: 64 * GB, bestVramBytes: 24 * GB });
    expect(catalog.models.length).toBe(9);
    for (const m of catalog.models) expect(fitFor(p, m).estimated.kv, m.id).toBe(false); // no silent fallback
    expect(fitFor(p, { id: "qwen2.5:latest", label: "x", params: 7.6 }).estimated.kv).toBe(false); // own-pulled alias tag
    for (const id of ["qwen2.5:3b-evil", "__proto__", "constructor", "../x", "", "x".repeat(10_000)]) {
      expect(() => fitFor(p, { id, label: "x", params: 3 })).not.toThrow();
      expect(fitFor(p, { id, label: "x", params: 3 }).estimated.kv, JSON.stringify(id).slice(0, 20)).toBe(true);
    }
  });

  it("N3: the REAL catalog 14B on a 16 GB Mac is amber 'only just fits' — not red, not green", () => {
    const catalog = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../catalog/models.json", import.meta.url)), "utf8")) as {
      models: { id: string; label: string; params: number; sizeBytes: number; quant: string }[];
    };
    const q14 = catalog.models.find((m) => m.id === "qwen2.5:14b")!;
    const v = verdict(profile({ ramBytes: 16 * GB, unifiedMemory: true }), [q14]);
    expect(v.fits[0]!.tier).toBe("amber");
    expect(v.fits[0]!.note).toBe("Only just fits in this computer's memory — it may crowd your other apps."); // Mac wording (N10)
  });

  it("an embedding model the user pulled gets a tier but never a writing speed", () => {
    const v = verdict(profile({ ramBytes: 64 * GB, bestVramBytes: 24 * GB }), [{ id: "nomic-embed-text:latest", label: "x", params: 0.137 }]);
    expect(v.fits[0]!.tier).toBe("green");
    expect(v.fits[0]!.tokPerSec).toBeNull();
  });

  it("uses the shared architecture data for a known catalog id, and estimates for an unknown one", () => {
    const p = profile({ ramBytes: 64 * GB, bestVramBytes: 24 * GB });
    const known = fitFor(p, { id: "qwen2.5:14b", label: "x", params: 14.77 });
    const unknown = fitFor(p, { id: "someone/else:14b", label: "x", params: 14.77 });
    expect(known.estimated.kv).toBe(false);
    expect(unknown.estimated.kv).toBe(true);
  });
});
