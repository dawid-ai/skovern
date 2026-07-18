import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { verdict, type HardwareProfile } from "@skovern/core";
import { snapshotCatalog, validateCatalog } from "./catalog.js";
import { builtInCandidates } from "./guided-verdict.js";

// Loop 038 — the built-in floor. The two smallest catalog tiers (0.5B + 1.5B) are now real
// gguf files, so the weakest machines get a runnable pick. Everything is asserted over the REAL
// shipped snapshot (not a fixture), so "what we tested" can't drift from "what we ship".

const GB = 1024 ** 3;

const PINS = {
  "qwen2.5:0.5b": {
    url: "https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q4_k_m.gguf",
    sha256: "74a4da8c9fdbcd15bd1f6d01d621410d31c6fc00986f5eb687824e7b93d7a9db",
    sizeBytes: 491400032,
    filename: "qwen2.5-0.5b-instruct-q4_k_m.gguf",
    contextSize: 4096,
  },
  "qwen2.5:1.5b": {
    url: "https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf",
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
    sizeBytes: 1117320736,
    filename: "qwen2.5-1.5b-instruct-q4_k_m.gguf",
    contextSize: 4096,
  },
} as const;

// The live catalog is the shipped github file; read it raw so U1 can assert snapshot ↔ live agree.
const liveCatalog = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../catalog/models.json", import.meta.url)), "utf8"),
) as { models: Array<{ id: string; gguf?: unknown }> };

function profile(p: Partial<HardwareProfile>): HardwareProfile {
  return { ramBytes: null, cpuCores: 8, gpus: [], bestVramBytes: null, unifiedMemory: false, diskFreeBytes: 200 * GB, notes: [], ...p };
}

describe("catalog tiers — built-in floor (loop 038)", () => {
  it("U1: the shipped snapshot AND the live catalog carry the floor gguf, correctly pinned and in agreement", () => {
    const snap = snapshotCatalog();
    for (const [id, pin] of Object.entries(PINS)) {
      const s = snap.find((m) => m.id === id);
      expect(s, `${id} missing from snapshot`).toBeDefined();
      expect(s!.gguf).toEqual(pin); // exact pins: https url, 64-hex sha, sizeBytes, filename, contextSize
      const l = liveCatalog.models.find((m) => m.id === id);
      expect(l, `${id} missing from live catalog`).toBeDefined();
      expect(l!.gguf).toEqual(pin); // snapshot ↔ live agree — no drift
    }
  });

  it("U2: validateCatalog accepts the floor gguf but DROPS a malformed one (the path-sink guard)", () => {
    // positive: the shipped snapshot is validateCatalog(snapshot), so the built-in ladder
    // (0.5/1.5/3/7/14B) surviving WITH gguf blocks already proves they clear validation.
    expect(snapshotCatalog().filter((m) => m.gguf).length).toBeGreaterThanOrEqual(5);
    // negative: a traversing filename and a non-https url each drop the WHOLE model.
    const good = snapshotCatalog().find((m) => m.id === "qwen2.5:1.5b")!;
    const traversing = { ...good, id: "evil", gguf: { ...PINS["qwen2.5:1.5b"], filename: "../evil.gguf" } };
    const insecure = { ...good, id: "evil2", gguf: { ...PINS["qwen2.5:1.5b"], url: "http://huggingface.co/x.gguf" } };
    expect(validateCatalog({ models: [traversing] })).toBeNull(); // only model dropped → null
    expect(validateCatalog({ models: [insecure] })).toBeNull();
    // alongside a good model, only the bad one drops (proves it's the gguf, not the wrapper)
    expect(validateCatalog({ models: [traversing, good] })!.map((m) => m.id)).toEqual(["qwen2.5:1.5b"]);
  });

  it("U3: WEAK (~2 GB RAM, no GPU) recommends the 1.5B floor over the REAL catalog", () => {
    const v = verdict(profile({ ramBytes: 2 * GB }), builtInCandidates(snapshotCatalog()));
    expect(v.recommendedModelId).toBe("qwen2.5:1.5b"); // 3B no longer fits (red at 2GB); 1.5B is biggest usable
  });

  it("U4: TINY (~1 GB RAM, no GPU) recommends the 0.5B — the only rung that fits", () => {
    const v = verdict(profile({ ramBytes: 1 * GB }), builtInCandidates(snapshotCatalog()));
    expect(v.recommendedModelId).toBe("qwen2.5:0.5b"); // 1.5B red at 1GB; the smallest catches this machine
  });

  it("U5: 24 GB GPU still recommends the 14B — adding the floor doesn't move a capable machine's pick", () => {
    const v = verdict(profile({ ramBytes: 64 * GB, bestVramBytes: 24 * GB }), builtInCandidates(snapshotCatalog()));
    expect(v.recommendedModelId).toBe("qwen2.5:14b");
  });
});
