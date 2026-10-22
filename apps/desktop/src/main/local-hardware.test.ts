import { afterEach, describe, expect, it, vi } from "vitest";

// The hardware scan shapes systeminformation's output into an honest profile. We
// mock `systeminformation` so the test is deterministic (the real probe is
// machine-dependent + slow): assert the best GPU wins over a weak iGPU, Apple
// unified memory is recognized, and a missing field degrades to null + a note.

// vi.hoisted so the mock factory (hoisted above imports) can reference `si`.
const si = vi.hoisted(() => ({ mem: vi.fn(), graphics: vi.fn(), cpu: vi.fn(), fsSize: vi.fn() }));
vi.mock("systeminformation", () => ({ default: si }));

import { isUnifiedApu, scanHardware, usesSharedMemory } from "./hardware.js";

const MB = 1024 * 1024;
const GB = 1024 * MB;

// The registry VRAM read shells out to a platform tool (machine-coupled, not fixturable), so we
// inject a stub in every test to keep the si-parsing assertions deterministic (loop 039).
const noReg = (): Promise<number | null> => Promise.resolve(null);

afterEach(() => vi.clearAllMocks());

describe("scanHardware", () => {
  it("picks the strongest GPU when a weak iGPU sits beside a strong dGPU", async () => {
    si.mem.mockResolvedValue({ total: 100 * GB });
    si.graphics.mockResolvedValue({
      controllers: [
        { model: "Intel UHD 770", vram: 2048, vendor: "Intel" },
        { model: "AMD Radeon RX 7900 XTX", vram: 24560, vendor: "Advanced Micro Devices, Inc." },
      ],
    });
    si.cpu.mockResolvedValue({ cores: 24, manufacturer: "Intel" });
    si.fsSize.mockResolvedValue([{ available: 500 * GB }]);

    const p = await scanHardware(noReg);
    expect(p.gpus).toHaveLength(2);
    // best = the 24.5 GB card, not the 2 GB iGPU
    expect(p.bestVramBytes).toBe(Math.round(24560 * MB));
    expect(p.unifiedMemory).toBe(false);
    expect(p.ramBytes).toBe(100 * GB);
    expect(p.cpuCores).toBe(24);
  });

  it("recognizes Apple unified memory", async () => {
    si.mem.mockResolvedValue({ total: 16 * GB });
    si.graphics.mockResolvedValue({ controllers: [{ model: "Apple M2", vram: 0, vendor: "Apple" }] });
    si.cpu.mockResolvedValue({ cores: 8, manufacturer: "Apple" });
    si.fsSize.mockResolvedValue([{ available: 200 * GB }]);

    const p = await scanHardware(noReg);
    expect(p.unifiedMemory).toBe(true);
  });

  // Dawid (2026-10-22): unified-memory boxes with no separate card (Mac minis, the newest NVIDIA
  // boxes) must not read as CPU-only. A Ryzen AI Max on Windows reports only its BIOS carve-out
  // (512 MB here) as VRAM, which alone would mean "no usable card".
  it("judges a Ryzen AI Max on its shared memory when the carve-out is small", async () => {
    si.mem.mockResolvedValue({ total: 127.5 * GB });
    si.graphics.mockResolvedValue({
      controllers: [{ model: "AMD Radeon(TM) 8060S Graphics", vram: 512, vendor: "Advanced Micro Devices, Inc." }],
    });
    si.cpu.mockResolvedValue({ cores: 16, manufacturer: "AMD", brand: "Ryzen AI MAX+ 395 w/ Radeon 8060S" });
    si.fsSize.mockResolvedValue([{ available: 500 * GB }]);

    const p = await scanHardware(() => Promise.resolve(512 * MB));
    expect(p.unifiedMemory).toBe(true);
  });

  it("keeps a Ryzen AI Max on its carve-out when the user gave the graphics most of the memory", async () => {
    // AMD Variable Graphics Memory at 96 of 128 GB: Windows sees 32 GB of RAM and 96 GB of VRAM.
    si.mem.mockResolvedValue({ total: 32 * GB });
    si.graphics.mockResolvedValue({ controllers: [{ model: "AMD Radeon(TM) 8060S Graphics", vram: 4096, vendor: "AMD" }] });
    si.cpu.mockResolvedValue({ cores: 16, manufacturer: "AMD", brand: "Ryzen AI MAX+ 395 w/ Radeon 8060S" });
    si.fsSize.mockResolvedValue([{ available: 500 * GB }]);

    const p = await scanHardware(() => Promise.resolve(96 * GB));
    expect(p.unifiedMemory).toBe(false);
    expect(p.bestVramBytes).toBe(96 * GB);
  });

  it("judges an NVIDIA GB10 (DGX Spark) on its shared memory; its VRAM reads as unknown", async () => {
    si.mem.mockResolvedValue({ total: 119 * GB });
    si.graphics.mockResolvedValue({ controllers: [{ model: "NVIDIA GB10", vram: null, vendor: "NVIDIA" }] });
    si.cpu.mockResolvedValue({ cores: 20, manufacturer: "ARM", brand: "Cortex-X925" });
    si.fsSize.mockResolvedValue([{ available: 3000 * GB }]);

    const p = await scanHardware(noReg);
    expect(p.unifiedMemory).toBe(true);
    // Shared memory is the answer, so no "couldn't detect your graphics memory" note.
    expect(p.notes.some((n) => /graphics memory/i.test(n))).toBe(false);
  });

  it("leaves an ordinary laptop iGPU (Radeon 890M) as no usable card", async () => {
    si.mem.mockResolvedValue({ total: 32 * GB });
    si.graphics.mockResolvedValue({ controllers: [{ model: "AMD Radeon(TM) 890M Graphics", vram: 512, vendor: "AMD" }] });
    si.cpu.mockResolvedValue({ cores: 12, manufacturer: "AMD", brand: "Ryzen AI 9 HX 370 w/ Radeon 890M" });
    si.fsSize.mockResolvedValue([{ available: 500 * GB }]);

    const p = await scanHardware(noReg);
    expect(p.unifiedMemory).toBe(false);
  });

  it("degrades honestly when graphics can't be read (null + a note, never a crash)", async () => {
    si.mem.mockResolvedValue({ total: 8 * GB });
    si.graphics.mockRejectedValue(new Error("no WMI"));
    si.cpu.mockResolvedValue({ cores: 4, manufacturer: "Intel" });
    si.fsSize.mockResolvedValue([]);

    const p = await scanHardware(noReg);
    expect(p.bestVramBytes).toBeNull();
    expect(p.gpus).toEqual([]);
    expect(p.notes.some((n) => /graphics/i.test(n))).toBe(true);
    expect(p.diskFreeBytes).toBeNull();
  });

  it("notes when memory itself is unreadable", async () => {
    si.mem.mockRejectedValue(new Error("nope"));
    si.graphics.mockResolvedValue({ controllers: [{ model: "GPU", vram: 8192, vendor: "NVIDIA" }] });
    si.cpu.mockResolvedValue({ cores: 8, manufacturer: "Intel" });
    si.fsSize.mockResolvedValue([{ available: 100 * GB }]);

    const p = await scanHardware(noReg);
    expect(p.ramBytes).toBeNull();
    expect(p.notes.some((n) => /memory/i.test(n))).toBe(true);
  });

  // The 039 fix: si saw the card's NAME but returned no VRAM (exactly what happened in Dawid's
  // Electron main), so without a backstop the 24 GB card read as CPU-only → "runs slowly". The
  // authoritative registry value fills it in, and no "couldn't detect graphics memory" note fires.
  it("uses the registry VRAM when si returns a named GPU with no readable memory (the 24GB-as-CPU-only bug)", async () => {
    si.mem.mockResolvedValue({ total: 96 * GB });
    si.graphics.mockResolvedValue({ controllers: [{ model: "AMD Radeon RX 7900 XTX", vram: null, vendor: "Advanced Micro Devices, Inc." }] });
    si.cpu.mockResolvedValue({ cores: 24, manufacturer: "Intel" });
    si.fsSize.mockResolvedValue([{ available: 500 * GB }]);

    const p = await scanHardware(() => Promise.resolve(24 * GB)); // registry backstops the null si vram
    expect(p.bestVramBytes).toBe(24 * GB); // not null → not CPU-only → models show "runs great"
    expect(p.notes.some((n) => /graphics memory/i.test(n))).toBe(false);
    // the registry VRAM is attributed to the discrete card, so the screen names it (not "Graphics card")
    expect(p.gpus.find((g) => g.model.includes("7900 XTX"))?.vramBytes).toBe(24 * GB);
  });
});

describe("unified-memory chips", () => {
  it("names the Ryzen AI Max and GB10 parts as they're reported, and nothing else", () => {
    for (const name of [
      "AMD Radeon(TM) 8060S Graphics",
      "AMD Radeon 8050S",
      "Radeon 8040S Graphics",
      "Strix Halo [Radeon Graphics / Radeon 8050S / 8060S Graphics]",
      "AMD RYZEN AI MAX+ 395 w/ Radeon 8060S",
      "NVIDIA GB10",
    ]) {
      expect(isUnifiedApu(name), name).toBe(true);
    }
    for (const name of ["AMD Radeon(TM) 890M Graphics", "Ryzen AI 9 HX 370", "Intel(R) Arc(TM) 140V GPU", "NVIDIA GeForce RTX 4090", "AMD Radeon RX 7900 XTX", "NVIDIA GB100"]) {
      expect(isUnifiedApu(name), name).toBe(false);
    }
  });

  it("uses the shared pool only when it beats the carve-out, and never with unknown RAM", () => {
    expect(usesSharedMemory(true, false, null, null)).toBe(true); // Apple: always
    expect(usesSharedMemory(false, true, 128 * GB, 16 * GB)).toBe(true); // 84 GB shared beats 16 GB
    expect(usesSharedMemory(false, true, 64 * GB, 64 * GB)).toBe(false); // 64 GB carve-out beats 42 GB shared
    expect(usesSharedMemory(false, true, null, 2 * GB)).toBe(false); // RAM unknown: keep the card reading
    expect(usesSharedMemory(false, false, 128 * GB, null)).toBe(false); // not a unified chip
  });
});
