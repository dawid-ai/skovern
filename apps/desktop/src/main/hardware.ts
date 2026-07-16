import si from "systeminformation";
import type { GpuInfo, HardwareProfile } from "@skovern/core";

// Best-effort, cross-platform hardware scan for the honesty engine. Runs in the
// TRUSTED main process only (systeminformation shells out to platform tools —
// never from a renderer). EVERY probe is guarded: a field we can't read becomes
// `null` + an honest note, never a guessed number and never a crash.

const MB = 1024 * 1024;

async function safe<T>(fn: () => Promise<T>): Promise<T | null> {
  try {
    return await fn();
  } catch {
    return null;
  }
}

// systeminformation reports controller VRAM in MB (and sometimes 0/negative when
// it couldn't read it). Convert to bytes, or null when it's not a real number.
function vramBytesOf(raw: unknown): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 0) return null;
  return Math.round(raw * MB);
}

export async function scanHardware(): Promise<HardwareProfile> {
  const notes: string[] = [];

  const [mem, graphics, cpu, fs] = await Promise.all([
    safe(() => si.mem()),
    safe(() => si.graphics()),
    safe(() => si.cpu()),
    safe(() => si.fsSize()),
  ]);

  const ramBytes = mem && typeof mem.total === "number" && mem.total > 0 ? mem.total : null;
  if (ramBytes === null) notes.push("We couldn't read this computer's memory, so our guess about speed is rough.");

  const cpuCores = cpu && typeof cpu.cores === "number" && cpu.cores > 0 ? cpu.cores : null;

  // Apple Silicon shares one pool of memory between CPU and GPU (unified memory).
  const cpuVendor = `${cpu?.manufacturer ?? ""} ${cpu?.vendor ?? ""}`.toLowerCase();
  const controllers = graphics?.controllers ?? [];
  const appleGpu = controllers.some((c) => `${c.vendor ?? ""} ${c.model ?? ""}`.toLowerCase().includes("apple"));
  const unifiedMemory = appleGpu || cpuVendor.includes("apple");

  // Capture EVERY controller; pick the best VRAM. A weak iGPU next to a strong
  // dGPU must not hide the dGPU — max() over all of them does that.
  const gpus: GpuInfo[] = controllers.map((c) => ({
    model: typeof c.model === "string" && c.model.length > 0 ? c.model : "Unknown graphics",
    vramBytes: vramBytesOf(c.vram),
    vendor: typeof c.vendor === "string" ? c.vendor : undefined,
  }));

  const vramValues = gpus.map((g) => g.vramBytes).filter((v): v is number => v !== null);
  const bestVramBytes = vramValues.length > 0 ? Math.max(...vramValues) : null;

  if (graphics === null) {
    notes.push("We couldn't check your graphics — we'll estimate from your memory instead.");
  } else if (!unifiedMemory && bestVramBytes === null) {
    notes.push("We couldn't detect your graphics memory — estimating from your regular memory instead.");
  }

  // Free disk on the drive with the most room (best-effort — where a model would go).
  let diskFreeBytes: number | null = null;
  if (Array.isArray(fs) && fs.length > 0) {
    const avail = fs.map((d) => d.available).filter((a): a is number => typeof a === "number" && a > 0);
    if (avail.length > 0) diskFreeBytes = Math.max(...avail);
  }

  return { ramBytes, cpuCores, gpus, bestVramBytes, unifiedMemory, diskFreeBytes, notes };
}
