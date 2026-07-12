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

    const p = await scanHardware();
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

    const p = await scanHardware();
    expect(p.unifiedMemory).toBe(true);
  });

  it("degrades honestly when graphics can't be read (null + a note, never a crash)", async () => {
    si.mem.mockResolvedValue({ total: 8 * GB });
    si.graphics.mockRejectedValue(new Error("no WMI"));
    si.cpu.mockResolvedValue({ cores: 4, manufacturer: "Intel" });
    si.fsSize.mockResolvedValue([]);

    const p = await scanHardware();
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

    const p = await scanHardware();
    expect(p.ramBytes).toBeNull();
    expect(p.notes.some((n) => /memory/i.test(n))).toBe(true);
  });
});
