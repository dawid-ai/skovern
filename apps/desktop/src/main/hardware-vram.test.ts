import { describe, expect, it } from "vitest";
import { verdict, type HardwareProfile } from "@skovern/core";
import { parseVramBytes, bestVram } from "./hardware.js";

// Loop 039 — a discrete GPU must never read as CPU-only. Dawid's 24 GB AMD card came back from
// si.graphics().vram as null inside Electron, so the verdict used the CPU-only budget and called a
// 0.5B model "runs slowly". The registry backstops that; these pin the reading + its consequence.

const GB = 1024 ** 3;

describe("VRAM detection helpers (loop 039)", () => {
  it("U1: parseVramBytes reads a positive byte count from the registry read, else null", () => {
    expect(parseVramBytes("25753026560\n")).toBe(25753026560); // the real 7900 XTX qwMemorySize
    expect(parseVramBytes("  24000000000  ")).toBe(24000000000);
    expect(parseVramBytes("0")).toBeNull();
    expect(parseVramBytes("")).toBeNull();
    expect(parseVramBytes("garbage")).toBeNull();
    expect(parseVramBytes("-4000000000")).toBeNull();
  });

  it("U2: bestVram takes the LARGER source, backstopping a null one", () => {
    expect(bestVram(24 * GB, 24 * GB)).toBe(24 * GB);
    expect(bestVram(null, 24 * GB)).toBe(24 * GB); // si failed → registry backstops (Dawid's case)
    expect(bestVram(24 * GB, null)).toBe(24 * GB); // registry failed → si backstops
    expect(bestVram(null, null)).toBeNull(); // both failed → honest CPU-only fallback
    expect(bestVram(4 * GB, 24 * GB)).toBe(24 * GB); // a capped/partial source can't shrink a good one
  });

  it("U3: a real VRAM value makes a 0.5B 'green'; VRAM null makes it amber — the exact bug→fix", () => {
    const base: HardwareProfile = {
      ramBytes: 96 * GB,
      cpuCores: 24,
      gpus: [{ model: "AMD Radeon RX 7900 XTX", vramBytes: null }],
      bestVramBytes: null,
      unifiedMemory: false,
      diskFreeBytes: 500 * GB,
      notes: [],
    };
    const small = [{ id: "qwen2.5:0.5b", label: "Qwen2.5 0.5B", params: 0.5, sizeBytes: 491400032, fetchable: true }];
    // VRAM null → CPU-only budget → "runs slowly" (amber) — exactly what Dawid saw
    expect(verdict(base, small).fits[0]!.tier).toBe("amber");
    // the SAME machine with its real 24 GB read → "runs great" (green)
    expect(verdict({ ...base, bestVramBytes: 24 * GB }, small).fits[0]!.tier).toBe("green");
  });
});
