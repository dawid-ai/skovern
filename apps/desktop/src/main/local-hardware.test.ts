import { afterEach, describe, expect, it, vi } from "vitest";

// The hardware scan shapes systeminformation's output into an honest profile. We
// mock `systeminformation` so the test is deterministic (the real probe is
// machine-dependent + slow): assert the best GPU wins over a weak iGPU, Apple
// unified memory is recognized, and a missing field degrades to null + a note.

// vi.hoisted so the mock factory (hoisted above imports) can reference `si`.
const si = vi.hoisted(() => ({ mem: vi.fn(), graphics: vi.fn(), cpu: vi.fn(), fsSize: vi.fn() }));
vi.mock("systeminformation", () => ({ default: si }));

import { scanHardware } from "./hardware.js";

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
