import { execFile } from "node:child_process";
import { promisify } from "node:util";
import si from "systeminformation";
import type { GpuInfo, HardwareProfile } from "@skovern/core";

// Best-effort, cross-platform hardware scan for the honesty engine. Runs in the
// TRUSTED main process only (systeminformation shells out to platform tools —
// never from a renderer). EVERY probe is guarded: a field we can't read becomes
// `null` + an honest note, never a guessed number and never a crash.

const MB = 1024 * 1024;

const execFileP = promisify(execFile);

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

/** Parse the powershell max-`qwMemorySize` output (bytes) into a positive integer, or null. */
export function parseVramBytes(stdout: string): number | null {
  const n = Number(stdout.trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

/** The best VRAM to trust: the LARGER of the two sources so whichever one read successfully
 *  wins (si returned null VRAM in a real Electron run on a 24 GB AMD card; the registry is the
 *  authoritative backstop, and vice-versa). Null only when BOTH failed. */
export function bestVram(siVram: number | null, registryVram: number | null): number | null {
  const vals = [siVram, registryVram].filter((v): v is number => typeof v === "number" && v > 0);
  return vals.length > 0 ? Math.max(...vals) : null;
}

// A discrete GPU by name (best-effort): the registry's max VRAM belongs to it, not an iGPU. Used
// only to attribute a registry-supplied VRAM to the right card when si couldn't read it, so the
// setup screen names the card instead of a generic "Graphics card".
export function isDiscreteGpu(model: string): boolean {
  const m = model.toLowerCase();
  if (/\buhd\b|\biris\b|integrated|\(r\) graphics|vega \d+ graphics|radeon graphics/.test(m)) return false;
  return /radeon rx|radeon pro|geforce|\brtx\b|\bgtx\b|nvidia|intel arc|\barc\b|instinct|quadro|firepro/.test(m);
}

// Windows: read dedicated VRAM authoritatively from the registry. `si.graphics().vram` is flaky
// inside Electron main (it returned null on a real 24 GB AMD card → the machine read as CPU-only
// and every model showed "runs slowly"). The dedicated VRAM is the 64-bit `qwMemorySize` under
// each display adapter's class key; take the max across adapters (the strong dGPU beats an iGPU).
// Shell-free `execFile` of a CONSTANT script (no interpolated input → no injection), 5s timeout,
// window hidden. Non-Windows / any failure → null (the si path stands).
async function registryVramBytes(): Promise<number | null> {
  if (process.platform !== "win32") return null;
  const script =
    "$k='HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';" +
    "$max=0;" +
    "Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object {" +
    "$v=(Get-ItemProperty $_.PSPath -Name 'HardwareInformation.qwMemorySize' -ErrorAction SilentlyContinue).'HardwareInformation.qwMemorySize';" +
    "if($v -and $v -gt $max){$max=$v}" +
    "};" +
    "Write-Output $max";
  try {
    // Invoke the interpreter by its absolute system path, not bare "powershell.exe", so a
    // PATH/CWD-planted binary can't be the spawn target (defense-in-depth — SECURE note 039).
    const powershell = `${process.env["SystemRoot"] ?? "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
    const { stdout } = await execFileP(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      timeout: 5000,
      windowsHide: true,
    });
    return parseVramBytes(stdout);
  } catch {
    return null;
  }
}

/** The hardware scan. `readRegistryVram` is injectable so tests stay deterministic (the real read
 *  shells out to a platform tool — machine-coupled, not fixturable); production uses the default. */
export async function scanHardware(
  readRegistryVram: () => Promise<number | null> = registryVramBytes,
): Promise<HardwareProfile> {
  const notes: string[] = [];

  const [mem, graphics, cpu, fs, registryVram] = await Promise.all([
    safe(() => si.mem()),
    safe(() => si.graphics()),
    safe(() => si.cpu()),
    safe(() => si.fsSize()),
    readRegistryVram(),
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

  const siVramValues = gpus.map((g) => g.vramBytes).filter((v): v is number => v !== null);
  const siBestVram = siVramValues.length > 0 ? Math.max(...siVramValues) : null;
  // The authoritative registry value backstops si's flaky read (and vice-versa): use the larger,
  // so a null or capped source can never silently downgrade a real GPU to CPU-only.
  const bestVramBytes = bestVram(siBestVram, registryVram);

  // When the registry supplied the VRAM that si couldn't read, attribute it to the strongest
  // discrete GPU so the profile is consistent — the setup screen can then name the actual card
  // (matches by vramBytes) instead of falling back to a generic "Graphics card".
  if (bestVramBytes !== null && !siVramValues.includes(bestVramBytes)) {
    const idx = gpus.findIndex((g) => g.vramBytes === null && isDiscreteGpu(g.model));
    if (idx >= 0) gpus[idx] = { ...gpus[idx]!, vramBytes: bestVramBytes };
  }

  // Dev-only diagnostic: what each VRAM source actually returned in THIS process (the definitive
  // confirmation of the Electron `si`-null failure + the registry fix). Dev builds only.
  if (process.env["NODE_ENV"] === "development") {
    console.log(`[hardware] VRAM sources — si=${siBestVram ?? "null"} registry=${registryVram ?? "null"} → chosen=${bestVramBytes ?? "null"}`);
  }

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
